# Example app

This Convex app installs the component from this repository.

```bash
npm ci
npx convex codegen --component-dir ./src/component
npx tsc --project tsconfig.build.json
npx convex dev
npx convex env set XQUIK_API_KEY xq_your_key
npx convex run example:profile '{"username": "NASA"}'
```

`example:pull` starts a repeating event pull. `example:watch` creates a webhook that reaches the component's receiver. `example:events` lists stored events for signed-in users.
