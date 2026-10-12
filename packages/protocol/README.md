# @lanework/protocol

The HTTP contract between the [Lanework](https://lanework.dev) desktop app,
its checkpoint hook and the Lanework API: request and response types, path
builders and a few shared constants. It has no runtime dependencies.

```ts
import { paths, type MachineMeResponse } from "@lanework/protocol";

const res = await fetch(`https://api.lanework.dev${paths.machinesMe()}`, {
  headers: { authorization: `Bearer ${token}` },
});
const me = (await res.json()) as MachineMeResponse;
```

The package ships TypeScript source (`src/index.ts`). Use it from a bundler or
from TypeScript with `"moduleResolution": "bundler"`.

MIT. See [LICENSE](LICENSE). The name and logo are covered by the
repository's [TRADEMARKS.md](https://github.com/fuongz/lanework/blob/main/TRADEMARKS.md).
