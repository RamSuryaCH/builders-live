# Contributing

Thanks for helping other meetup organizers.

Builders Live is source-available and open for non-commercial use. Commercial use is not permitted.

## Licenses

By submitting a contribution you agree that:

- Code is licensed under the PolyForm Noncommercial License 1.0.0. See `LICENSE`.
- Event content, documentation, and images are licensed under CC BY-NC 4.0. See `LICENSE-CONTENT`.

The licensor is Ram Surya Chelluboyina (https://github.com/RamSuryaCH).

## Local loop

```bash
npm ci
npm run dev
```

The local host PIN is `local-dev-pin`. It is only for the process on your machine. Do not reuse it as a deploy PIN, and do not commit a real one.

```bash
npm test
npm run load-test
npm run secret-scan
```

## What to change for your meetup

Edit `content/event.json` and `content/questions.json`. Do not put account IDs, emails, or secrets in those files. The host PIN and the budget email are deploy parameters.

## Pull requests

Keep the app serverless: no always-on servers, no NAT gateways, no provisioned capacity. Explain how an attendee or a host notices the change.
