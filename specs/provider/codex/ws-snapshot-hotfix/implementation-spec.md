# Implementation Spec

Patch target: `packages/opencode-codex-provider/src/transport-ws.ts`.

Minimal implementation intent:

```ts
getSnapshot: () => ({
  wsFrameCount: wsObs.frameCount,
  terminalEventReceived: wsObs.terminalEventReceived,
  terminalEventType: wsObs.terminalEventType,
  wsCloseCode: wsObs.wsCloseCode,
  wsCloseReason: wsObs.wsCloseReason,
  serverErrorMessage: wsObs.serverErrorMessage,
  deltasObserved: { ...wsObs.deltasObserved },
})
```

Do not change retry count, finish reason mapping, or runloop nudge behavior in this hotfix.
