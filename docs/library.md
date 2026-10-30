# Using visualice as a library

```ts
import { loadConfig, crawlPipeline } from "visualice";

const config = await loadConfig("visualice.config.ts");
const { runDir, manifest } = await crawlPipeline({ config, baseUrl: "https://your.site" });
```

`src/index.ts` re-exports the pipelines, the config schema, the manifest helpers and the pure
utilities (URL normalization, globs, robots parsing). The package ships built ESM plus type
declarations (`dist/`, produced by `npm run build`), so consumers need no `tsx`. Node 22.18
or newer (it runs a `visualice.config.ts` natively).
