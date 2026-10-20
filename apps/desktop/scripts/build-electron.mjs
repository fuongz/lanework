import { build } from "esbuild";
import { buildDictation } from "./build-dictation.mjs";
import {
  electronBuildOptions,
  stageNativeModules,
} from "./electron-bundle.mjs";

await build(electronBuildOptions);
await stageNativeModules();
await buildDictation();
