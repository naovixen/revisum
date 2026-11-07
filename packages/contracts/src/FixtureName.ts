import type { Brand } from "./brand.ts";

// A file the trusted project declares in its fixtures list, which an upload step may send.
export type FixtureName = Brand<string, "FixtureName">;
