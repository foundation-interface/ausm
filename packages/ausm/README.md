# ausm

ausm (activity understanding and scaffolding medium) turns what you do on your Mac into live, typed context for apps and agents: what you select, type, copy and capture, which window or file you're looking at, and what task you're working on. It runs on your machine and hands your code structured events as they happen.

```sh
npm install ausm
```

```ts
import { createRuntime } from 'ausm/runtime';

const runtime = createRuntime();
runtime.onTextSelectionEvent((e) => console.log('selected', e.selectedText));
runtime.onTaskEvent((e) => console.log('task', e.status, e.taskLabel));
await runtime.initialize();
```

- Source: https://github.com/foundation-interface/ausm
- Docs: https://foundation-interface.github.io/ausm/

MIT licensed. macOS 13+.
