import { loadConfig } from "../../../packages/config/src/index.js";
import {
  normalizeMilkyMessage,
  normalizeOneBotMessage,
  normalizeSatoriMessage,
  parseBotCommand,
  sendChannelMessage,
  type ChannelProtocol,
  type NormalizedChannelMessage,
} from "../../../packages/channel-adapters/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import { dispatchBotTurn } from "./dispatch.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);

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
  }
}

function listen(protocol: ChannelProtocol): boolean {
  const settings = config.qqBotProtocols[protocol];
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
  const reply = dispatchBotTurn(message, command);
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
  const connected = Object.keys(config.qqBotProtocols)
    .filter((name): name is ChannelProtocol =>
      ["onebot11", "satori", "milky"].includes(name),
    )
    .map((protocol) => listen(protocol))
    .some(Boolean);

  if (!connected) {
    logger.info("no QQ bot protocols configured; exiting");
    return;
  }
  logger.info(
    { protocols: Object.keys(config.qqBotProtocols) },
    "QQ bot running",
  );

  // The gateway sockets keep the process alive; only exit on a signal.
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      logger.info("QQ bot shutting down");
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

void main().catch((error: unknown) => {
  logger.error({ err: error }, "QQ bot failed");
  process.exitCode = 1;
});
