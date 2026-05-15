# Contributing

## Development

```sh
npm install
npm run check
```

Local worker execution loads `.env` from the project root. Use `.env.example` as the template and do not commit `.env`.

## Pull requests

- Keep capability keys stable unless the change intentionally breaks existing deployments.
- Update `README.md` when setup, configuration, commands, or public behavior changes.
- Run `npm run check` before opening a pull request.
- Do not include access keys, Notion workspace IDs, generated `workers.json`, run logs, or personal environment paths.
