import { RateLimitError, Worker, type Schedule } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

const TRACK17_API_BASE_URL = "https://api.17track.net/track/v2.4";
const TRACK17_CARRIER_LIST_URL =
  "https://res.17track.net/asset/carrier/info/apicarrier.all.json";
const TRACK17_TOKEN_ENV = "TRACK17_API_TOKEN";
const SHIPMENTS_SYNC_SCHEDULE_ENV = "SHIPMENTS_SYNC_SCHEDULE";
const DEFAULT_SHIPMENTS_SYNC_SCHEDULE = "1h";
const TRACK17_RATE_LIMIT = worker.pacer("track17Api", {
  allowedRequests: 3,
  intervalMs: 1000,
});
const carrierNameCache = new Map<number, string>();
let carrierListPromise: Promise<Map<number, string>> | undefined;
let carrierListItemsPromise: Promise<CarrierListItem[]> | undefined;

const PACKAGE_STATUS_OPTIONS = [
  { name: "Unknown", color: "default" },
  { name: "NotFound", color: "gray" },
  { name: "InfoReceived", color: "gray" },
  { name: "InTransit", color: "blue" },
  { name: "Expired", color: "gray" },
  { name: "AvailableForPickup", color: "purple" },
  { name: "OutForDelivery", color: "blue" },
  { name: "DeliveryFailure", color: "orange" },
  { name: "Delivered", color: "green" },
  { name: "Exception", color: "red" },
] as const;

const TRACKING_STATUS_OPTIONS = [
  { name: "Unknown", color: "default" },
  { name: "Tracking", color: "blue" },
  { name: "Stopped", color: "gray" },
] as const;

const STOP_REASON_OPTIONS = [
  { name: "None", color: "default" },
  { name: "Expired", color: "gray" },
  { name: "ByRequest", color: "orange" },
  { name: "InvalidCarrier", color: "red" },
] as const;

const ESTIMATED_DELIVERY_SOURCE_OPTIONS = [
  { name: "None", color: "default" },
  { name: "Official", color: "green" },
  { name: "17TRACK", color: "blue" },
  { name: "Unknown", color: "gray" },
] as const;

const shipments = worker.database("shipments", {
  type: "managed",
  initialTitle: "17TRACK Shipments",
  primaryKeyProperty: "Tracking Key",
  schema: {
    databaseIcon: Builder.emojiIcon("📦"),
    properties: {
      Name: Schema.title(),
      "Carrier Name": Schema.richText(),
      "Package Status": Schema.select([...PACKAGE_STATUS_OPTIONS]),
      "Estimated Delivery Date": Schema.date(),
      "Estimated Delivery Window": Schema.richText(),
      "Latest Event": Schema.richText(),
      "Latest Event Location": Schema.richText(),
      "Latest Event At": Schema.date(),
      "Picked Up At": Schema.date(),
      "Tracking Key": Schema.richText(),
      "Tracking Number": Schema.richText(),
      "17TRACK URL": Schema.url(),
      "Tracking Status": Schema.select([...TRACKING_STATUS_OPTIONS]),
      "Tracking Active": Schema.checkbox(),
      "Carrier Code": Schema.number(),
      "Last-mile Carrier Code": Schema.number(),
      "Last-mile Carrier Name": Schema.richText(),
      "Origin Country": Schema.richText(),
      "Destination Country": Schema.richText(),
      "Registered At": Schema.date(),
      "Last Tracked At": Schema.date(),
      "Stopped At": Schema.date(),
      "Delivered At": Schema.date(),
      "Estimated Delivery Value": Schema.richText(),
      "Estimated Delivery Source": Schema.select([
        ...ESTIMATED_DELIVERY_SOURCE_OPTIONS,
      ]),
      "Stop Reason": Schema.select([...STOP_REASON_OPTIONS]),
      Retracked: Schema.checkbox(),
      "Carrier Changes": Schema.number(),
      Remark: Schema.richText(),
    },
  },
});

type ApiEnvelope<T> = {
  code: number;
  data: T;
  page?: {
    data_total?: number;
    page_total?: number;
    page_no?: number;
    page_size?: number;
  };
};

type RejectedTrack17Item = {
  number?: string;
  carrier?: number | string;
  error?: {
    code?: number;
    message?: string;
  };
};

type RegisterAcceptedItem = {
  origin?: number;
  number: string;
  carrier?: number;
  tag?: string | null;
  email?: string | null;
  lang?: string | null;
};

type TrackingNumberActionAcceptedItem = {
  number: string;
  carrier?: number | string;
};

type CarrierListItem = {
  key?: number;
  _name?: string;
  _country_iso?: string;
  _url?: string | null;
};

type TrackListItem = {
  number: string;
  carrier?: number;
  final_carrier?: number;
  shipping_country?: string | null;
  recipient_country?: string | null;
  origin_country?: string | null;
  destination_country?: string | null;
  register_time?: string | null;
  tracking_status?: string | null;
  package_status?: string | number | null;
  track_time?: string | null;
  stop_track_time?: string | null;
  stop_track_reason?: string | null;
  is_retracked?: boolean;
  carrier_change_count?: number;
  tag?: string | null;
  order_time?: string | null;
  remark?: string | null;
  latest_event_time?: string | null;
  latest_event_info?: string | null;
  delievery_time?: string | null;
  delivery_time?: string | null;
  pickup_time?: string | null;
  track_info?: TrackInfo | null;
};

type TrackEvent = {
  time_iso?: string | null;
  time_utc?: string | null;
  description?: string | null;
  description_translation?: {
    lang?: string | null;
    description?: string | null;
  } | null;
  location?: string | null;
  stage?: string | null;
  sub_status?: string | null;
};

type EstimatedDeliveryDate = {
  source?: string | null;
  from?: string | null;
  to?: string | null;
};

type TrackInfo = {
  latest_status?: {
    status?: string | null;
    sub_status?: string | null;
    sub_status_descr?: string | null;
  } | null;
  latest_event?: TrackEvent | null;
  time_metrics?: {
    days_after_order?: number | null;
    days_after_last_update?: number | null;
    days_of_transit?: number | null;
    days_of_transit_done?: number | null;
    estimated_delivery_date?: EstimatedDeliveryDate | null;
  } | null;
};

type TrackInfoItem = TrackListItem;

type BatchResponse<TAccepted> = {
  accepted?: TAccepted[];
  rejected?: RejectedTrack17Item[];
  errors?: unknown;
};

type ShipmentsSyncState = {
  page: number;
  pageSignatures?: string[];
};

type TrackListPage = {
  items: TrackListItem[];
  pageTotal?: number;
};

worker.sync("shipmentsSync", {
  database: shipments,
  mode: "replace",
  schedule: getShipmentsSyncSchedule(),
  execute: async (state: ShipmentsSyncState | undefined) => {
    const page = state?.page ?? 1;
    const pageResult = await getTrackedShipmentsPage(page);
    const tracked = pageResult.items;

    if (tracked.length === 0) {
      return { changes: [], hasMore: false };
    }

    const pageSignature = trackListPageSignature(tracked);
    if (state?.pageSignatures?.includes(pageSignature)) {
      console.warn(
        `17TRACK gettracklist returned a repeated page at page ${page}; ending sync cycle.`,
      );
      return { changes: [], hasMore: false };
    }

    const details = await getTrackInfoFor(tracked);
    const carrierNames = await getCarrierNamesFor(
      collectCarrierCodes(tracked, details),
    );
    const hasMore = pageResult.pageTotal ? page < pageResult.pageTotal : true;

    return {
      changes: tracked.map((item) =>
        toShipmentUpsert(item, details, carrierNames),
      ),
      hasMore,
      nextState: hasMore
        ? {
            page: page + 1,
            pageSignatures: [...(state?.pageSignatures ?? []), pageSignature],
          }
        : undefined,
    };
  },
});

worker.tool("searchCarrierCodes", {
  title: "Search 17TRACK Carrier Codes",
  description:
    "Search the 17TRACK carrier list and return carrier codes that can be used with addTrackingNumber.",
  schema: j.object({
    query: j
      .string()
      .describe(
        "Carrier name or country code to search for, such as FedEx, China Post, USPS, or CN.",
      ),
  }),
  execute: async ({ query }) => {
    const normalizedQuery = query.trim().toLowerCase();
    const carriers = await getCarrierListItems();
    const matches = carriers
      .filter((carrier) => {
        const name = carrier._name?.toLowerCase() ?? "";
        const country = carrier._country_iso?.toLowerCase() ?? "";
        const key = typeof carrier.key === "number" ? String(carrier.key) : "";
        return (
          name.includes(normalizedQuery) ||
          country === normalizedQuery ||
          key === normalizedQuery
        );
      })
      .slice(0, 10)
      .map((carrier) => ({
        carrierCode: carrier.key ?? null,
        name: carrier._name ?? "",
        countryCode: carrier._country_iso ?? null,
        url: carrier._url ?? null,
      }));

    return {
      query,
      count: matches.length,
      matches,
    };
  },
});

worker.tool("addTrackingNumber", {
  title: "Add 17TRACK Tracking Number",
  description:
    "Register a package tracking number with 17TRACK so it is tracked and synced into the 17TRACK Shipments database.",
  schema: j.object({
    trackingNumber: j.string().describe("Package tracking number to register. 17TRACK carrier auto-detection is enabled."),
  }),
  execute: async ({ trackingNumber }) => {
    const request: Record<string, string | number | boolean> = {
      number: trackingNumber.trim(),
      auto_detection: true,
    };

    const response = await callTrack17<BatchResponse<RegisterAcceptedItem>>(
      "/register",
      [request],
    );
    const accepted = response.data.accepted ?? [];
    const rejected = response.data.rejected ?? [];

    return {
      message: addTrackingNumberResultMessage(accepted.length),
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      accepted: accepted.map((item) => ({
        trackingNumber: item.number,
        carrierCode: item.carrier ?? null,
        origin: item.origin ?? null,
        trackingUrl: trackingUrl(item.number),
      })),
      rejected: rejected.map((item) => ({
        trackingNumber: item.number ?? trackingNumber,
        carrierCode: item.carrier ?? null,
        errorCode: item.error?.code ?? null,
        message: item.error?.message ?? "Rejected by 17TRACK.",
      })),
    };
  },
});

worker.tool("addTrackingNumberWithCarrier", {
  title: "Add 17TRACK Tracking Number With Carrier",
  description:
    "Register a package tracking number with 17TRACK using a specific 17TRACK carrier code from searchCarrierCodes.",
  schema: j.object({
    trackingNumber: j.string().describe("Package tracking number to register."),
    carrierCode: j.integer().describe("17TRACK carrier code returned by searchCarrierCodes."),
  }),
  execute: async ({ trackingNumber, carrierCode }) => {
    const response = await callTrack17<BatchResponse<RegisterAcceptedItem>>(
      "/register",
      [{ number: trackingNumber.trim(), carrier: carrierCode }],
    );
    const accepted = response.data.accepted ?? [];
    const rejected = response.data.rejected ?? [];

    return {
      message: addTrackingNumberResultMessage(accepted.length),
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      accepted: accepted.map((item) => ({
        trackingNumber: item.number,
        carrierCode: item.carrier ?? null,
        origin: item.origin ?? null,
        trackingUrl: trackingUrl(item.number),
      })),
      rejected: rejected.map((item) => ({
        trackingNumber: item.number ?? trackingNumber,
        carrierCode: item.carrier ?? null,
        errorCode: item.error?.code ?? null,
        message: item.error?.message ?? "Rejected by 17TRACK.",
      })),
    };
  },
});

worker.tool("removeTrackingNumber", {
  title: "Remove 17TRACK Tracking Number",
  description:
    "Delete a package tracking number from 17TRACK. The shipment will be removed from the synced Notion database on the next shipmentsSync run.",
  schema: j.object({
    trackingNumber: j
      .string()
      .describe("Package tracking number to delete from 17TRACK."),
  }),
  execute: async ({ trackingNumber }) => {
    const response = await callTrack17<
      BatchResponse<TrackingNumberActionAcceptedItem>
    >("/deletetrack", [{ number: trackingNumber.trim() }]);
    const accepted = response.data.accepted ?? [];
    const rejected = response.data.rejected ?? [];

    return {
      message: removeTrackingNumberResultMessage(accepted.length),
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      accepted: accepted.map((item) => ({
        trackingNumber: item.number,
        carrierCode: item.carrier ?? null,
      })),
      rejected: rejected.map((item) => ({
        trackingNumber: item.number ?? trackingNumber,
        carrierCode: item.carrier ?? null,
        errorCode: item.error?.code ?? null,
        message: item.error?.message ?? "Rejected by 17TRACK.",
      })),
    };
  },
});

function addTrackingNumberResultMessage(acceptedCount: number): string {
  if (acceptedCount === 0)
    return "No tracking numbers were registered. See rejected for 17TRACK errors.";
  return `Tracking number registered with 17TRACK. 17TRACK may take up to 5 minutes to return tracking results; after that, it will appear in Notion on the next shipmentsSync run based on SHIPMENTS_SYNC_SCHEDULE (${getConfiguredShipmentsSyncScheduleLabel()}).`;
}

function removeTrackingNumberResultMessage(acceptedCount: number): string {
  if (acceptedCount === 0)
    return "No tracking numbers were removed. See rejected for 17TRACK errors.";
  return `Tracking number removed from 17TRACK. It will disappear from Notion on the next shipmentsSync run based on SHIPMENTS_SYNC_SCHEDULE (${getConfiguredShipmentsSyncScheduleLabel()}).`;
}

function getConfiguredShipmentsSyncScheduleLabel(): string {
  return (
    process.env[SHIPMENTS_SYNC_SCHEDULE_ENV]?.trim() ||
    DEFAULT_SHIPMENTS_SYNC_SCHEDULE
  );
}

function toShipmentUpsert(
  item: TrackListItem,
  details: TrackInfoItem[],
  carrierNames: ReadonlyMap<number, string>,
) {
  const detail = findTrackInfo(details, item);
  const trackInfo = detail?.track_info ?? item.track_info ?? undefined;
  const latestEvent = trackInfo?.latest_event ?? undefined;
  const carrier = firstNumber(item.carrier, detail?.carrier);
  const lastMileCarrier = firstNumber(
    item.final_carrier,
    detail?.final_carrier,
  );
  const packageStatus = packageStatusName(
    trackInfo?.latest_status?.status ??
      detail?.package_status ??
      item.package_status,
  );
  const trackingStatus = trackingStatusName(
    detail?.tracking_status ?? item.tracking_status,
  );
  const estimatedDelivery =
    trackInfo?.time_metrics?.estimated_delivery_date ?? undefined;
  const estimatedDeliveryParsed = parseEstimatedDelivery(estimatedDelivery);
  const estimatedDeliveryValue = estimatedDeliveryRawValue(estimatedDelivery);
  const upstreamUpdatedAt = toIsoDateTime(
    latestEvent?.time_utc ??
      latestEvent?.time_iso ??
      detail?.track_time ??
      item.track_time ??
      detail?.latest_event_time ??
      item.latest_event_time,
  );

  return {
    type: "upsert" as const,
    key: trackingKey(item.number, carrier),
    upstreamUpdatedAt: upstreamUpdatedAt ?? undefined,
    icon: packageStatusIcon(packageStatus),
    properties: {
      Name: Builder.title(item.number),
      "Carrier Name": Builder.richText(
        carrier ? (carrierNames.get(carrier) ?? "") : "",
      ),
      "Package Status": Builder.select(packageStatus),
      "Estimated Delivery Date": estimatedDeliveryParsed
        ? Builder.date(estimatedDeliveryParsed.date)
        : Builder.richText(""),
      "Estimated Delivery Window": Builder.richText(
        estimatedDeliveryParsed?.window ?? "",
      ),
      "Latest Event": Builder.richText(
        firstString(
          latestEvent?.description_translation?.description,
          latestEvent?.description,
          detail?.latest_event_info,
          item.latest_event_info,
        ),
      ),
      "Latest Event Location": Builder.richText(
        firstString(latestEvent?.location),
      ),
      "Latest Event At": optionalDateTime(
        latestEvent?.time_utc ??
          latestEvent?.time_iso ??
          detail?.latest_event_time ??
          item.latest_event_time,
      ),
      "Picked Up At": optionalDateTime(detail?.pickup_time ?? item.pickup_time),
      "Tracking Key": Builder.richText(trackingKey(item.number, carrier)),
      "Tracking Number": Builder.richText(item.number),
      "17TRACK URL": Builder.url(trackingUrl(item.number)),
      "Tracking Status": Builder.select(trackingStatus),
      "Tracking Active": Builder.checkbox(trackingStatus !== "Stopped"),
      "Carrier Code": optionalNumber(carrier),
      "Last-mile Carrier Code": optionalNumber(lastMileCarrier),
      "Last-mile Carrier Name": Builder.richText(
        lastMileCarrier ? (carrierNames.get(lastMileCarrier) ?? "") : "",
      ),
      "Origin Country": Builder.richText(
        firstString(
          detail?.origin_country,
          item.origin_country,
          detail?.shipping_country,
          item.shipping_country,
        ),
      ),
      "Destination Country": Builder.richText(
        firstString(
          detail?.destination_country,
          item.destination_country,
          detail?.recipient_country,
          item.recipient_country,
        ),
      ),
      "Registered At": optionalDateTime(
        detail?.register_time ?? item.register_time,
      ),
      "Last Tracked At": optionalDateTime(
        detail?.track_time ?? item.track_time,
      ),
      "Stopped At": optionalDateTime(
        detail?.stop_track_time ?? item.stop_track_time,
      ),
      "Delivered At": optionalDateTime(
        detail?.delivery_time ??
          detail?.delievery_time ??
          item.delivery_time ??
          item.delievery_time,
      ),
      "Estimated Delivery Value": Builder.richText(estimatedDeliveryValue),
      "Estimated Delivery Source": Builder.select(
        estimatedDeliverySourceName(estimatedDelivery?.source),
      ),
      "Stop Reason": Builder.select(
        stopReasonName(detail?.stop_track_reason ?? item.stop_track_reason),
      ),
      Retracked: Builder.checkbox(
        detail?.is_retracked ?? item.is_retracked ?? false,
      ),
      "Carrier Changes": optionalNumber(
        detail?.carrier_change_count ?? item.carrier_change_count,
      ),
      Remark: Builder.richText(firstString(detail?.remark, item.remark)),
    },
  };
}

async function getTrackedShipmentsPage(page: number): Promise<TrackListPage> {
  await TRACK17_RATE_LIMIT.wait();
  const response = await callTrack17<BatchResponse<TrackListItem>>(
    "/gettracklist",
    {
      page_no: page,
      order_by: "RegisterTimeAsc",
    },
  );

  return {
    items: response.data.accepted ?? [],
    pageTotal: response.page?.page_total,
  };
}

async function getTrackInfoFor(
  items: TrackListItem[],
): Promise<TrackInfoItem[]> {
  const chunks = chunk(items, 40);
  const results: TrackInfoItem[] = [];

  for (const chunkItems of chunks) {
    await TRACK17_RATE_LIMIT.wait();
    const response = await callTrack17<BatchResponse<TrackInfoItem>>(
      "/gettrackinfo",
      chunkItems.map((item) => ({
        number: item.number,
        ...(item.carrier ? { carrier: item.carrier } : {}),
      })),
    );
    results.push(...(response.data.accepted ?? []));
  }

  return results;
}

function collectCarrierCodes(
  items: TrackListItem[],
  details: TrackInfoItem[],
): number[] {
  const codes = new Set<number>();
  for (const item of items) {
    const detail = findTrackInfo(details, item);
    for (const code of [
      item.carrier,
      detail?.carrier,
      item.final_carrier,
      detail?.final_carrier,
    ]) {
      if (typeof code === "number" && Number.isFinite(code)) codes.add(code);
    }
  }
  return [...codes];
}

async function getCarrierNamesFor(
  codes: number[],
): Promise<Map<number, string>> {
  const missingCodes = codes.filter((code) => !carrierNameCache.has(code));
  if (missingCodes.length > 0) {
    try {
      const carrierList = await getCarrierList();
      for (const code of missingCodes) {
        carrierNameCache.set(code, carrierList.get(code) ?? "");
      }
    } catch (error) {
      console.warn("Unable to resolve 17TRACK carrier names.", error);
      for (const code of missingCodes) carrierNameCache.set(code, "");
    }
  }

  return new Map(codes.map((code) => [code, carrierNameCache.get(code) ?? ""]));
}

async function getCarrierList(): Promise<Map<number, string>> {
  carrierListPromise ??= fetchCarrierList();
  return carrierListPromise;
}

async function getCarrierListItems(): Promise<CarrierListItem[]> {
  carrierListItemsPromise ??= fetchCarrierListItems();
  return carrierListItemsPromise;
}

async function fetchCarrierList(): Promise<Map<number, string>> {
  const items = await getCarrierListItems();
  const carriers = new Map<number, string>();
  for (const item of items) {
    if (typeof item.key === "number" && item._name?.trim()) {
      carriers.set(item.key, item._name.trim());
    }
  }
  return carriers;
}

async function fetchCarrierListItems(): Promise<CarrierListItem[]> {
  const response = await fetch(TRACK17_CARRIER_LIST_URL);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `17TRACK carrier list failed with HTTP ${response.status}: ${text}`,
    );
  }

  return JSON.parse(text) as CarrierListItem[];
}

async function callTrack17<T>(
  path: string,
  body: unknown,
): Promise<ApiEnvelope<T>> {
  const token = process.env[TRACK17_TOKEN_ENV];
  if (!token) {
    throw new Error(
      `${TRACK17_TOKEN_ENV} is not set. Configure it with: ntn workers env set ${TRACK17_TOKEN_ENV}=your-17track-access-key`,
    );
  }

  const response = await fetch(`${TRACK17_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "17token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new RateLimitError({
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `17TRACK ${path} failed with HTTP ${response.status}: ${text}`,
    );
  }

  const parsed = JSON.parse(text) as ApiEnvelope<T>;
  if (parsed.code !== 0) {
    throw new Error(
      `17TRACK ${path} failed with API code ${parsed.code}: ${text}`,
    );
  }

  return parsed;
}

function getShipmentsSyncSchedule(): Schedule {
  const raw = process.env[SHIPMENTS_SYNC_SCHEDULE_ENV]?.trim();
  if (!raw) return DEFAULT_SHIPMENTS_SYNC_SCHEDULE;
  if (raw === "manual" || raw === "continuous") return raw;

  const match = raw.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error(
      `${SHIPMENTS_SYNC_SCHEDULE_ENV} must be "manual", "continuous", or an interval like "30m", "1h", or "1d". Got: ${raw}`,
    );
  }

  const value = Number(match[1]);
  const unit = match[2];
  const intervalMs =
    value * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
  if (intervalMs < 60_000 || intervalMs > 7 * 86_400_000) {
    throw new Error(
      `${SHIPMENTS_SYNC_SCHEDULE_ENV} must be between 1 minute and 7 days. Got: ${raw}`,
    );
  }

  return raw as Schedule;
}

function trackListPageSignature(items: TrackListItem[]): string {
  return items.map((item) => trackingKey(item.number, item.carrier)).join("\n");
}

function findTrackInfo(
  details: TrackInfoItem[],
  item: TrackListItem,
): TrackInfoItem | undefined {
  const expectedKey = trackingKey(item.number, item.carrier);
  return (
    details.find(
      (detail) => trackingKey(detail.number, detail.carrier) === expectedKey,
    ) ?? details.find((detail) => detail.number === item.number)
  );
}

function trackingKey(number: string, carrier?: number): string {
  return carrier ? `${number}:${carrier}` : number;
}

function trackingUrl(number: string): string {
  return `https://www.17track.net/en/track-details?nums=${encodeURIComponent(number)}`;
}

function packageStatusName(value?: string | number | null): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (PACKAGE_STATUS_OPTIONS.some((option) => option.name === normalized))
      return normalized;
  }

  if (typeof value === "number") {
    switch (value) {
      case 0:
        return "NotFound";
      case 10:
        return "InTransit";
      case 20:
        return "Expired";
      case 30:
        return "AvailableForPickup";
      case 35:
        return "DeliveryFailure";
      case 40:
        return "Delivered";
      case 50:
        return "Exception";
    }
  }

  return "Unknown";
}

function trackingStatusName(value?: string | null): string {
  const normalized = value?.trim();
  return normalized === "Tracking" || normalized === "Stopped"
    ? normalized
    : "Unknown";
}

function stopReasonName(value?: string | null): string {
  const normalized = value?.trim();
  return normalized === "Expired" ||
    normalized === "ByRequest" ||
    normalized === "InvalidCarrier"
    ? normalized
    : "None";
}

function estimatedDeliverySourceName(value?: string | null): string {
  const normalized = value?.trim();
  if (!normalized) return "None";
  return normalized === "Official" || normalized === "17TRACK"
    ? normalized
    : "Unknown";
}

function packageStatusIcon(status: string) {
  switch (status) {
    case "Delivered":
      return Builder.emojiIcon("✅");
    case "Exception":
    case "DeliveryFailure":
      return Builder.emojiIcon("⚠️");
    case "InTransit":
    case "AvailableForPickup":
    case "OutForDelivery":
      return Builder.emojiIcon("🚚");
    default:
      return Builder.emojiIcon("📦");
  }
}

function optionalNumber(value?: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Builder.number(value)
    : Builder.richText("");
}

function optionalDateTime(value?: string | null) {
  const iso = toIsoDateTime(value);
  return iso ? Builder.dateTime(iso) : Builder.richText("");
}

type ParsedEstimatedDelivery = {
  date: string;
  window: string;
};

function parseEstimatedDelivery(
  value?: EstimatedDeliveryDate | null,
): ParsedEstimatedDelivery | null {
  const rawValue = estimatedDeliveryRawValue(value);
  const displayRange = parseDisplayEstimatedDeliveryValue(rawValue);
  if (displayRange) return displayRange;

  const from = parseEstimatedDeliveryEndpoint(value?.from);
  const to = parseEstimatedDeliveryEndpoint(value?.to);
  if (!from || !to || from.date !== to.date) return null;

  return {
    date: from.date,
    window: `${formatTimeWindowEndpoint(from)} → ${formatTimeWindowEndpoint(to)}`,
  };
}

function estimatedDeliveryRawValue(
  value?: EstimatedDeliveryDate | null,
): string {
  const from = value?.from?.trim();
  const to = value?.to?.trim();
  if (from && to) return `${from} → ${to}`;
  return from ?? to ?? "";
}

function parseEstimatedDeliveryEndpoint(
  value?: string | null,
): { date: string; hour: number; minute: number } | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!match) return null;

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { date: match[1], hour, minute };
}

function parseDisplayEstimatedDeliveryValue(
  value: string,
): ParsedEstimatedDelivery | null {
  const match = value.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4}) (\d{1,2}:\d{2} [AP]M) → (\d{1,2}:\d{2} [AP]M)$/,
  );
  if (!match) return null;

  const month = monthNumber(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || day < 1 || day > 31) return null;

  return {
    date: `${year}-${month}-${String(day).padStart(2, "0")}`,
    window: `${match[4]} → ${match[5]}`,
  };
}

function monthNumber(month: string): string | null {
  const index = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ].indexOf(month);
  return index === -1 ? null : String(index + 1).padStart(2, "0");
}

function formatTimeWindowEndpoint(value: {
  hour: number;
  minute: number;
}): string {
  const period = value.hour >= 12 ? "PM" : "AM";
  const hour = value.hour % 12 || 12;
  return `${hour}:${String(value.minute).padStart(2, "0")} ${period}`;
}

function toIsoDateTime(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("2079-01-01")) return null;

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();

  const dateTimeMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/,
  );
  if (dateTimeMatch)
    return `${dateTimeMatch[1]}T${dateTimeMatch[2]}:${dateTimeMatch[3] ?? "00"}Z`;

  const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) return `${dateMatch[1]}T00:00:00Z`;

  return null;
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
}

function firstString(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
