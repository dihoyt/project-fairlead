# Contributing

Contributions are accepted under the MIT License, the same licence the project is distributed under (inbound = outbound). Nothing else is required: no CLA.

Sign off every commit to certify the [Developer Certificate of Origin](https://developercertificate.org/):

```
git commit -s
```

which adds `Signed-off-by: Your Name <you@example.com>` to the message.

Before opening a pull request, run what CI runs:

```
npm ci && npm --prefix client ci
npm run check
```

`CLAUDE.md` describes how the repository is organised and the rules every change follows.
