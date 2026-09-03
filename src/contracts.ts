import type { AdobeCommandEnvelopeV1 } from "../../../packages/contracts/src/adobe.js";

export {
  ADOBE_TOOL_NAMES_V1,
  type AdobeCommandEnvelopeV1,
  AdobeCommandEnvelopeV1Schema,
  type AdobeCommandResultV1,
  AdobeCommandResultV1Schema,
} from "../../../packages/contracts/src/adobe.js";

export type QueuedCommand = AdobeCommandEnvelopeV1 & {
  readonly status: "QUEUED";
};
export type RunningCommand = AdobeCommandEnvelopeV1 & {
  readonly status: "RUNNING";
};
