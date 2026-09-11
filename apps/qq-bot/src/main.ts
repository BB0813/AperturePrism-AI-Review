import { loadConfig } from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  loadSettings,
} from "../../../packages/database/src/index.js";
import {
  createOfficialQqTokenStore,
  normalizeMilkyMessage,
  normalizeOfficialQqMessage,
  normalizeOneBotMessage,
  normalizeSatoriMessage,
  officialQqSendMessageRequest,
  parseBotCommand,
  sendChannelMessage,
  type ChannelProtocol,
  type NormalizedChannelMessage,
} from "../../../packages/channel-adapters/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import {
  dispatchBotTurn,
  defaultCommandReply,
  type DispatchAction,
} from "./dispatch.js";
import { createTaskAction } from "./exec.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);

/**
 * Real task executor injected in main() before any gateway connects. The
 * fallback acknowledges commands without side effects (used only in tests).
 */
let taskAction: DispatchAction = defaultCommandReply;

/**
 * Effective QQ bot config. Runtime settings (`qq_bot_protocols`,
 * `qq_official_*`) stored via the WebUI override the env values, so credentials
 * no longer have to be injected as environment variables. Overrides load at
 * startup (restart the bot to apply a change).
 */
type QqProtocol = { baseUrl: string; accessToken?: string; gatewayUrl?: string };
type EffectiveQq = {
  protocols: Record<string, QqProtocol>;
  officialAppId: string;
  officialAppSecret: string;
  officialGatewayUrl: string;
  officialIntents: number;
};
const qq: EffectiveQq = {
  protocols: config.qqBotProtocols as Record<string, QqProtocol>,
  officialAppId: config.qqOfficialAppId ?? "",
  officialAppSecret: config.qqOfficialAppSecret ?? "",
  officialGatewayUrl:
    config.qqOfficialGatewayUrl ?? "wss://api.sgroup.qq.com/websocket",
  officialIntents: config.qqOfficialIntents,
};

async function loadQqOverrides(): Promise<void> {
  try {
    const database = createDatabaseClient(config.databaseUrl);
    try {
      const map = await loadSettings(database.db, [
        "qq_bot_protocols",
        "qq_official_app_id",
        "qq_official_app_secret",
        "qq_official_gateway_url",
        "qq_official_intents",
      ]);
      const protocolsRaw = map.get("qq_bot_protocols");
      if (protocolsRaw && protocolsRaw.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(protocolsRaw);
          if (typeof parsed === "object" && parsed !== null)
            qq.protocols = parsed as Record<string, QqProtocol>;
        } catch {
          // keep env defaults when the stored JSON is malformed
        }
      }
      const appId = map.get("qq_official_app_id");
      if (appId && appId.trim()) qq.officialAppId = appId;
      const secret = map.get("qq_official_app_secret");
      if (secret && secret.trim()) qq.officialAppSecret = secret;
      const gateway = map.get("qq_official_gateway_url");
      if (gateway && gateway.trim()) qq.officialGatewayUrl = gateway;
      const intents = Number(map.get("qq_official_intents"));
      if (Number.isFinite(intents) && intents > 0) qq.officialIntents = intents;
    } finally {
      await database.close();
    }
  } catch (error) {
    logger.warn({ err: error }, "QQ settings override load failed");
  }
}

const OFFICIAL_GATEWAY_URL = qq.officialGatewayUrl;

function normalize(
  protocol: ChannelProtocol,
  raw: unknown,
): NormalizedChannelMessage | null {
  switch (protocol) {
    case "onebot11":
      return normalizeOneBotMessage(raw);
    case "satori":
      return normalizeSatoriMessage(raw);
    case "milky":
      return normalizeMilkyMessage(raw);
    case "officialqq":
      return null; // handled by the dedicated WebSocket loop below
  }
}

function listen(protocol: ChannelProtocol): boolean {
  const settings = qq.protocols[protocol];
  if (!settings?.gatewayUrl) return false;

  const connector = {
    baseUrl: settings.baseUrl,
    ...(settings.accessToken ? { accessToken: settings.accessToken } : {}),
  };
  let attempt = 0;

  const connect = (): void => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(settings.gatewayUrl as string);
    } catch (error) {
      logger.warn({ err: error, protocol }, "QQ gateway open failed, retrying");
      setTimeout(connect, 5_000);
      return;
    }
    logger.info(
      { protocol, gateway: settings.gatewayUrl },
      "QQ gateway connected",
    );

    socket.onopen = () => {
      attempt = 0;
    };
    socket.onmessage = (event) => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      void handleEvent(protocol, connector, data);
    };
    socket.onclose = () => {
      logger.info({ protocol }, "QQ gateway closed, reconnecting");
      setTimeout(connect, Math.min(30_000, 3_000 * 2 ** Math.min(attempt, 4)));
      attempt += 1;
    };
    socket.onerror = () => {
      socket.close();
    };
  };

  connect();
  return true;
}

async function handleEvent(
  protocol: ChannelProtocol,
  connector: { baseUrl: string; accessToken?: string },
  raw: unknown,
): Promise<void> {
  const message = normalize(protocol, raw);
  if (!message) return;
  const command = parseBotCommand(message.body);
  const reply = await dispatchBotTurn(message, command, taskAction);
  if (!reply) return;
  try {
    await sendChannelMessage(connector, {
      protocol,
      scene:
        message.scene === "private" || message.scene === "temp"
          ? "private"
          : "group",
      peerId: message.peerId,
      text: reply,
    });
  } catch (error) {
    logger.error(
      { err: error, protocol, peerId: message.peerId },
      "QQ reply send failed",
    );
  }
}

async function main(): Promise<void> {
  await loadQqOverrides();
  const database = createDatabaseClient(config.databaseUrl);
  taskAction = createTaskAction({
    apiBaseUrl: config.qqBotApiBaseUrl,
    apiToken: config.webuiApiToken ?? "",
    database,
  });
  if (!qq.officialAppId || !qq.officialAppSecret) {
    if (Object.keys(qq.protocols).length === 0) {
      logger.info("no QQ bot protocols configured; exiting");
      await database.close();
      return;
    }
  } else {
    connectOfficialQq();
  }

  for (const protocol of Object.keys(qq.protocols)) {
    if (["onebot11", "satori", "milky"].includes(protocol)) {
      listen(protocol as ChannelProtocol);
    }
  }

  logger.info("QQ bot running");
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      logger.info("QQ bot shutting down");
      void database.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/**
 * Official QQ open-platform bot: connects to the WebSocket gateway, performs
 * the Identify handshake, replies to C2C/GROUP_AT messages, and keeps the
 * connection alive with heartbeats. Live verification requires a QQ sandbox
 * AppID/AppSecret; the pure normalization/send logic is unit-tested.
 */
function connectOfficialQq(): void {
  if (!qq.officialAppId || !qq.officialAppSecret) return;
  const tokenStore = createOfficialQqTokenStore({
    appId: qq.officialAppId,
    clientSecret: qq.officialAppSecret,
  });
  let attempt = 0;
  let heartbeatMs = 30_000;
  // 会话状态跨重连持久化：READY 下发的 session_id + 已收到的最新 seq。
  // 官方网关重连时应走 op 6 RESUME 续接会话；若每次重连都重发 op 2 Identify，
  // 新会话会顶掉旧会话，导致约每 30 分钟被强制断线、事件订阅不稳、收不到消息。
  let sessionId = "";
  let lastSequence = 0;

  const connect = (): void => {
    let socket: WebSocket;
    let heartbeatTimer: unknown;

    const clearHeartbeat = (): void => {
      if (heartbeatTimer !== undefined)
        clearInterval(heartbeatTimer as NodeJS.Timeout);
    };

    try {
      socket = new WebSocket(OFFICIAL_GATEWAY_URL);
    } catch (error) {
      logger.warn({ err: error }, "official QQ gateway open failed, retrying");
      setTimeout(connect, 5_000);
      return;
    }
    logger.info(
      { gateway: OFFICIAL_GATEWAY_URL },
      "official QQ gateway connected",
    );

    socket.onopen = async () => {
      attempt = 0;
      try {
        const token = await tokenStore.getToken();
        const auth = `QQBot ${token}`;
        if (sessionId) {
          // 已有会话 → RESUME 续接（token + session_id + seq），不要重开 Identify。
          socket.send(
            JSON.stringify({
              op: 6,
              d: { token: auth, session_id: sessionId, seq: lastSequence },
            }),
          );
        } else {
          socket.send(
            JSON.stringify({
              op: 2,
              d: { token: auth, intents: qq.officialIntents, shard: [0, 1] },
            }),
          );
        }
      } catch (error) {
        logger.error(
          { err: error },
          "official QQ identify failed, reconnecting",
        );
        socket.close();
      }
    };

    socket.onmessage = (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const op = typeof data.op === "number" ? data.op : -1;
      const payload = data.d as Record<string, unknown> | undefined;

      if (
        op === 10 &&
        payload &&
        typeof payload.heartbeat_interval === "number"
      ) {
        heartbeatMs = payload.heartbeat_interval as number;
        clearHeartbeat();
        heartbeatTimer = setInterval(() => {
          socket.send(JSON.stringify({ op: 1, d: lastSequence }));
        }, heartbeatMs);
        return;
      }
      if (op === 0) {
        logger.info(
          {
            eventType: data.t ?? "(none)",
            hasPayload: payload === undefined ? false : true,
          },
          "official QQ dispatch received",
        );
        const sequence = typeof data.s === "number" ? data.s : lastSequence;
        if (sequence > lastSequence) lastSequence = sequence;
        // READY 事件通过 payload.session_id 下发，保存它以便重连时 RESUME。
        if (
          payload &&
          typeof payload.session_id === "string" &&
          payload.session_id.length > 0
        ) {
          sessionId = payload.session_id;
        }
        const eventType = typeof data.t === "string" ? data.t : undefined;
        const dispatch = {
          op: 0,
          s: sequence,
          ...(eventType === undefined ? {} : { t: eventType }),
          ...(payload === undefined ? {} : { d: payload }),
        };
        void handleOfficialQqDispatch(dispatch, tokenStore);
        return;
      }
      if (op === 7) {
        logger.info("official QQ requested reconnect");
        clearHeartbeat();
        socket.close();
        return;
      }
      // op 9 = invalid session：清除会话状态，下一次以全新 Identify 重连。
      if (op === 9) {
        logger.info("official QQ invalid session, reset");
        sessionId = "";
        lastSequence = 0;
        clearHeartbeat();
        socket.close();
        return;
      }
      // op 1 / 11 (heartbeat ack) 直接忽略即可。
    };

    socket.onclose = () => {
      clearHeartbeat();
      logger.info("official QQ gateway closed, reconnecting");
      setTimeout(connect, Math.min(30_000, 3_000 * 2 ** Math.min(attempt, 4)));
      attempt += 1;
    };
    socket.onerror = () => socket.close();
  };

  connect();
}

async function handleOfficialQqDispatch(
  dispatch: { op: number; s: number; t?: string; d?: unknown },
  tokenStore: ReturnType<typeof createOfficialQqTokenStore>,
): Promise<void> {
  const message = normalizeOfficialQqMessage(dispatch);
  logger.info(
    {
      eventType: dispatch.t ?? "(none)",
      normalized: message ? "ok" : "skip",
      scene: message?.scene,
      body: message?.body.slice(0, 80),
    },
    "official QQ message normalized",
  );
  if (!message) return;
  const command = parseBotCommand(message.body);
  const reply = await dispatchBotTurn(message, command, taskAction);
  if (!reply) return;
  const msgId = message.messageId.replace(/^oqq:/u, "");
  const request = officialQqSendMessageRequest({
    scene: message.scene === "private" ? "private" : "group",
    openid: message.peerId,
    content: reply,
    msgId,
  });
  try {
    const token = await tokenStore.getToken();
    const response = await fetch(request.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.error(
        { err: new Error(text.slice(0, 300)), peerId: message.peerId },
        "official QQ reply send failed",
      );
    }
  } catch (error) {
    logger.error(
      { err: error, peerId: message.peerId },
      "official QQ reply send failed",
    );
  }
}

void main().catch((error: unknown) => {
  logger.error({ err: error }, "QQ bot failed");
  process.exitCode = 1;
});
