import { build } from "esbuild";
import { buildDictation } from "./build-dictation.mjs";
import {
  electronBuildOptions,
  stageNativeModules,
  writeMetafile,
} from "./electron-bundle.mjs";

await writeMetafile(await build(electronBuildOptions));
await stageNativeModules();
await buildDictation();
