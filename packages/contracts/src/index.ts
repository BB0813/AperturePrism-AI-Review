export * from "./issue-analysis.js";
export * from "./grading.js";
export * from "./issue-title.js";

export type HealthStatus = {
  name: string;
  status: "ok";
};

export const apiHealth: HealthStatus = {
  name: "apertureprism-api",
  status: "ok",
};
