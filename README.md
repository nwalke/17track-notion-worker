# 17TRACK Notion Worker

Capabilities:

- `shipmentsSync`: replace-mode sync of active 17TRACK registrations into the managed `17TRACK Shipments` database every 30 minutes.
- `addTrackingNumber`: Custom Agent tool that registers a tracking number with 17TRACK.

## Setup

```sh
cd 17track
npm install
npm run check
```

Create a 17TRACK access key from the 17TRACK management console under `Settings -> Security -> Access Key`.

Local execution uses `.env`:

```sh
cp .env.example .env
# edit .env and set TRACK17_API_TOKEN
```

Hosted execution uses Worker secrets:

```sh
ntn workers create --name 17track
ntn workers env set TRACK17_API_TOKEN=your-17track-access-key
ntn workers deploy
```

## Commands

Preview the sync without writing to Notion:

```sh
ntn workers sync trigger shipmentsSync --preview
```

Run the sync:

```sh
ntn workers sync trigger shipmentsSync
```

Run the add tool locally:

```sh
ntn workers exec addTrackingNumber --local -d '{
  "trackingNumber": "RR123456789CN",
  "carrierCode": null,
  "finalCarrierCode": null,
  "extraParam": null,
  "tag": "example order",
  "autoDetection": true
}'
```

## Database

Primary key: `Tracking Key`, formatted as `trackingNumber:carrierCode` when a carrier code exists.

Synced properties include tracking number, 17TRACK URL, package status, tracking status, active flag, carrier codes, country codes, registration/tracking/push/stop times, stop reason, retrack flag, tag, latest event time/location/content, push HTTP status, and carrier-change count.

## 17TRACK API behavior

- API base URL: `https://api.17track.net/track/v1`.
- Token header: `17token`.
- Worker secret: `TRACK17_API_TOKEN`.
- Pacer: 3 requests per second, matching 17TRACK's documented v1 API limit.
- `shipmentsSync` reads `/gettracklist` with `tracking_state: 1`, then enriches each page with `/gettrackinfo` in chunks of 40.
- `addTrackingNumber` writes to `/register` and returns accepted/rejected records from 17TRACK.
