# 17TRACK Notion Worker

A self-deployable Notion Worker that syncs 17TRACK v2.4 registrations into a managed Notion database, including estimated delivery ranges when 17TRACK or the carrier provides them, and exposes tools for adding and removing tracking numbers.

## Capabilities

| Capability | Type | Behavior |
| --- | --- | --- |
| `shipmentsSync` | Sync | Replace-mode sync of 17TRACK registrations into the managed `17TRACK Shipments` database. |
| `searchCarrierCodes` | Tool | Searches 17TRACK carrier codes by carrier name, country code, or carrier code. |
| `addTrackingNumber` | Tool | Registers a package tracking number with 17TRACK auto-detection and returns accepted/rejected records. |
| `addTrackingNumberWithCarrier` | Tool | Registers a package tracking number with an explicit 17TRACK carrier code and returns accepted/rejected records. |
| `removeTrackingNumber` | Tool | Deletes a package tracking number from 17TRACK and returns accepted/rejected records. |

## Requirements

- Node.js `>=22.0.0`
- npm `>=10.9.2`
- Notion CLI (`ntn`) installed and authenticated with `ntn login`
- A Notion workspace where the worker can be deployed
- A 17TRACK account with an API access key from `Settings -> Security -> Access Key`

## Configuration

| Variable | Required | Default | Values |
| --- | --- | --- | --- |
| `TRACK17_API_TOKEN` | Yes | none | 17TRACK API access key. |
| `SHIPMENTS_SYNC_SCHEDULE` | No | `1h` | `manual`, `continuous`, or an interval from `1m` through `7d`, such as `30m`, `1h`, or `1d`. |

`SHIPMENTS_SYNC_SCHEDULE` is read when the worker is deployed. Change it with `ntn workers env set SHIPMENTS_SYNC_SCHEDULE=...` and redeploy.

## Deploy

```sh
git clone https://github.com/nwalke/17track-notion-worker.git
cd 17track-notion-worker
npm install
npm run check

ntn login
ntn workers create --name track17
ntn workers env set TRACK17_API_TOKEN=your-17track-access-key

# Optionally set the sync to whatever you want, default is 1 hour
ntn workers env set SHIPMENTS_SYNC_SCHEDULE=30m

ntn workers deploy
```

## Local development

Local execution loads `.env` from the project root. `ntn workers env set` configures the deployed worker, not local `--local` runs.

```sh
cp .env.example .env
# edit .env and set TRACK17_API_TOKEN
npm install
npm run check
```

Preview the sync locally without writing to Notion:

```sh
ntn workers sync trigger shipmentsSync --preview --local
```

Search carrier codes locally:

```sh
ntn workers exec searchCarrierCodes --local -d '{
  "query": "FedEx"
}'
```

Run the auto-detect add tool locally:

```sh
ntn workers exec addTrackingNumber --local -d '{
  "trackingNumber": "RR123456789CN"
}'
```

Run the explicit-carrier add tool locally:

```sh
ntn workers exec addTrackingNumberWithCarrier --local -d '{
  "trackingNumber": "RR123456789CN",
  "carrierCode": 3011
}'
```

Run the remove tool locally:

```sh
ntn workers exec removeTrackingNumber --local -d '{
  "trackingNumber": "RR123456789CN"
}'
```

## Operations

Preview the deployed sync without writing to Notion:

```sh
ntn workers sync trigger shipmentsSync --preview
```

Run the deployed sync and write to the managed Notion database:

```sh
ntn workers sync trigger shipmentsSync
```

Search carrier codes:

```sh
ntn workers exec searchCarrierCodes -d '{
  "query": "FedEx"
}'
```

Run the deployed auto-detect add tool:

```sh
ntn workers exec addTrackingNumber -d '{
  "trackingNumber": "RR123456789CN"
}'
```

Run the deployed explicit-carrier add tool:

```sh
ntn workers exec addTrackingNumberWithCarrier -d '{
  "trackingNumber": "RR123456789CN",
  "carrierCode": 3011
}'
```

Run the deployed remove tool:

```sh
ntn workers exec removeTrackingNumber -d '{
  "trackingNumber": "RR123456789CN"
}'
```

Check deployed sync health:

```sh
ntn workers sync status
```

List recent worker runs:

```sh
ntn workers runs list
```

Read logs for a run:

```sh
ntn workers runs logs <runId>
```

Reset sync state before a full resync:

```sh
ntn workers sync state reset shipmentsSync
ntn workers sync trigger shipmentsSync
```

## Database

Primary key: `Tracking Key`, formatted as `trackingNumber:carrierCode` when a carrier code exists.

Synced properties include tracking number, 17TRACK URL, package status, tracking status, active flag, carrier codes/names, origin/destination countries, registration/tracking/stop/delivery/pickup times, estimated delivery date/window/value/source, stop reason, retracked flag, remark, latest event time/location/content, and carrier-change count.

## 17TRACK API behavior

- API base URL: `https://api.17track.net/track/v2.4`.
- Token header: `17token`.
- Worker secret: `TRACK17_API_TOKEN`.
- Sync pacer: 3 requests per second, matching 17TRACK's documented API limit.
- `shipmentsSync` reads paginated `/gettracklist` results, then enriches each page with `/gettrackinfo` in chunks of 40.
- Carrier names are resolved from `https://res.17track.net/asset/carrier/info/apicarrier.all.json`; the worker fetches the carrier list once per runtime and caches resolved code-to-name values.
- Estimated delivery is read from `track_info.time_metrics.estimated_delivery_date`; the raw `from`/`to` value is synced into `Estimated Delivery Value`, and `Estimated Delivery Date` plus `Estimated Delivery Window` are only filled when the range parses successfully.
- `searchCarrierCodes` reads `https://res.17track.net/asset/carrier/info/apicarrier.all.json` and returns matching carrier codes.
- `addTrackingNumber` writes to `/register` with 17TRACK carrier auto-detection enabled and returns accepted/rejected records from 17TRACK.
- `addTrackingNumberWithCarrier` writes to `/register` with an explicit carrier code and returns accepted/rejected records from 17TRACK.
- `removeTrackingNumber` writes to `/deletetrack` and returns accepted/rejected records from 17TRACK; deletion is irreversible in 17TRACK, and the record disappears from Notion on the next replace-mode sync.

## Troubleshooting

- `TRACK17_API_TOKEN is not set`: run `ntn workers env set TRACK17_API_TOKEN=your-17track-access-key` for deployed execution or add it to `.env` for local execution.
- Invalid `SHIPMENTS_SYNC_SCHEDULE`: use `manual`, `continuous`, or an interval like `30m`, `1h`, or `1d`.
- Schedule changes not reflected: run `ntn workers env set SHIPMENTS_SYNC_SCHEDULE=...` and redeploy.
- 17TRACK API errors: verify the API access key, 17TRACK account quota, and tracking number registration status.

## Public-use notes

- Each deployment uses the deployer's own Notion workspace and 17TRACK API token.
- Do not commit `.env`, access keys, workspace IDs, generated `workers.json`, or run logs containing secrets.
- The managed Notion database is created and migrated by the worker deployment.

## License

GPL-3.0; see `LICENSE`.
