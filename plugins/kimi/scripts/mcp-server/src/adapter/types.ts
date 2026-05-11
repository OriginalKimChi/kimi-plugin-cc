export type KimiOutputFormat = "text" | "stream-json";

export interface KimiInvocation {
  prompt: string;
  workDir?: string;
  addDirs?: string[];
  sessionId?: string;
  maxStepsPerTurn?: number;
  model?: string;
  thinking?: boolean;
  noThinking?: boolean;
  outputFormat: KimiOutputFormat;
  finalMessageOnly?: boolean;
  configFile?: string;
}
