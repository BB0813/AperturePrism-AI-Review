import type { EvalSample } from "./eval.js";

export type DatasetIssue = { issueNumber: number; title: string; body: string };

export type DatasetEntry = EvalSample & {
  corpus: readonly DatasetIssue[];
};

/** Lead reference so each entry's corpus is self-contained. */
export function leadOf(entry: DatasetEntry): DatasetIssue {
  const id = Number(entry.id);
  const lead = entry.corpus.find((c) => c.issueNumber === id);
  if (!lead) throw new Error(`entry ${entry.id} has no corpus lead`);
  return lead;
}

/**
 * A small, hand-labeled duplicate-detection dataset for offline evaluation.
 * Labels here are ground truth (duplicate / not duplicate), not model output.
 */
export const labeledDataset: readonly DatasetEntry[] = [
  {
    id: "1",
    trueDuplicateNumbers: [2],
    relatedNumbers: [],
    corpus: [
      {
        issueNumber: 1,
        title: "App crashes with HTTP_511 when calling api module on startup",
        body: "Steps: open app, it calls ./api/src, HTTP_511 returned. Stack at api/client.ts.",
      },
      {
        issueNumber: 2,
        title: "startup crash HTTP_511 in api module",
        body: "after upgrade to v1.2.3 the api module throws HTTP_511 on boot",
      },
      {
        issueNumber: 3,
        title: "typo on settings page label",
        body: "label reads Settigns instead of Settings",
      },
    ],
  },
  {
    id: "4",
    trueDuplicateNumbers: [],
    relatedNumbers: [5],
    corpus: [
      {
        issueNumber: 4,
        title: "login button missing on mobile",
        body: "the login button does not appear on small screens",
      },
      {
        issueNumber: 5,
        title: "mobile layout login button hidden",
        body: "on phone the login button is pushed off-screen",
      },
      {
        issueNumber: 6,
        title: "fix: rename local variable",
        body: "rename x to y for clarity, no behavior change",
      },
    ],
  },
  {
    id: "7",
    trueDuplicateNumbers: [],
    relatedNumbers: [],
    corpus: [
      {
        issueNumber: 7,
        title: "crash on export large table",
        body: "exporting a large table crashes the app with out of memory",
      },
      {
        issueNumber: 8,
        title: "export table huge memory",
        body: "exporting big table uses too much memory and freezes",
      },
      {
        issueNumber: 9,
        title: "add dark theme toggle preference",
        body: "Users want a manual dark/light theme switcher in settings",
      },
    ],
  },
];