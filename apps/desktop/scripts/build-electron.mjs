import { build } from "esbuild";
import {
  electronBuildOptions,
  stageNativeModules,
} from "./electron-bundle.mjs";

await build(electronBuildOptions);
await stageNativeModules();
