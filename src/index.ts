import { RateLimitError, Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

const TRACK17_API_BASE_URL = "https://api.17track.net/track/v1";
const TRACK17_TOKEN_ENV = "TRACK17_API_TOKEN";
const TRACK17_RATE_LIMIT = worker.pacer("track17Api", {
	allowedRequests: 3,
	intervalMs: 1000,
});

const PACKAGE_STATUS_OPTIONS = [
	{ name: "Unknown", color: "default" },
	{ name: "Not found", color: "gray" },
	{ name: "In transit", color: "blue" },
	{ name: "Expired", color: "gray" },
	{ name: "Pick up", color: "purple" },
	{ name: "Undelivered", color: "orange" },
	{ name: "Delivered", color: "green" },
	{ name: "Alert", color: "red" },
] as const;

const TRACKING_STATUS_OPTIONS = [
	{ name: "Unknown", color: "default" },
	{ name: "Unable to track", color: "gray" },
	{ name: "Normal tracking", color: "blue" },
	{ name: "Not found", color: "gray" },
	{ name: "Web error", color: "orange" },
	{ name: "Process error", color: "orange" },
	{ name: "Service error", color: "red" },
	{ name: "Web error (cache)", color: "orange" },
	{ name: "Process error (cache)", color: "orange" },
	{ name: "Service error (cache)", color: "red" },
] as const;

const STOP_REASON_OPTIONS = [
	{ name: "None", color: "default" },
	{ name: "Expiration rules", color: "gray" },
	{ name: "API request", color: "orange" },
	{ name: "Manual operation", color: "orange" },
	{ name: "Invalid carrier", color: "red" },
] as const;

const shipments = worker.database("shipments", {
	type: "managed",
	initialTitle: "17TRACK Shipments",
	primaryKeyProperty: "Tracking Key",
	schema: {
		databaseIcon: Builder.emojiIcon("📦"),
		properties: {
			Name: Schema.title(),
			"Tracking Key": Schema.richText(),
			"Tracking Number": Schema.richText(),
			"17TRACK URL": Schema.url(),
			"Package Status": Schema.select([...PACKAGE_STATUS_OPTIONS]),
			"Tracking Status": Schema.select([...TRACKING_STATUS_OPTIONS]),
			"Tracking Active": Schema.checkbox(),
			"Carrier Code": Schema.number(),
			"Last-mile Carrier Code": Schema.number(),
			"Origin Country Code": Schema.number(),
			"Destination Country Code": Schema.number(),
			"Registered At": Schema.date(),
			"Last Tracked At": Schema.date(),
			"Last Pushed At": Schema.date(),
			"Stopped At": Schema.date(),
			"Stop Reason": Schema.select([...STOP_REASON_OPTIONS]),
			"Can Retrack": Schema.checkbox(),
			"Carrier Changes": Schema.number(),
			"Push HTTP Status": Schema.number(),
			Tag: Schema.richText(),
			"Latest Event At": Schema.date(),
			"Latest Event Location": Schema.richText(),
			"Latest Event": Schema.richText(),
		},
	},
});

type ApiEnvelope<T> = {
	code: number;
	data: T;
};

type RejectedTrack17Item = {
	number?: string;
	carrier?: number;
	error?: {
		code?: number;
		message?: string;
	};
};

type RegisterAcceptedItem = {
	origin?: number;
	number: string;
	carrier?: number;
};

type TrackListItem = {
	number: string;
	w1?: number;
	w2?: number;
	b?: number;
	c?: number;
	e?: number;
	rt?: string;
	tt?: string;
	pt?: string;
	ps?: number;
	st?: string;
	sr?: number;
	ir?: boolean;
	ts?: boolean;
	mc?: number;
	tag?: string | null;
};

type TrackEvent = {
	a?: string;
	c?: string;
	z?: string;
};

type TrackDetails = {
	b?: number;
	c?: number;
	e?: number;
	f?: number;
	w1?: number;
	w2?: number;
	z0?: TrackEvent | null;
	is1?: number;
	is2?: number;
	ylt1?: string;
	ylt2?: string;
	yt?: string;
};

type TrackInfoItem = {
	number: string;
	tag?: string | null;
	track?: TrackDetails;
};

type BatchResponse<TAccepted> = {
	accepted?: TAccepted[];
	rejected?: RejectedTrack17Item[];
	errors?: unknown;
};

type ShipmentsSyncState = {
	page: number;
};

worker.sync("shipmentsSync", {
	database: shipments,
	mode: "replace",
	schedule: "30m",
	execute: async (state: ShipmentsSyncState | undefined) => {
		const page = state?.page ?? 1;
		const tracked = await getTrackedShipmentsPage(page);

		if (tracked.length === 0) {
			return { changes: [], hasMore: false };
		}

		const details = await getTrackInfoFor(tracked);

		return {
			changes: tracked.map((item) => {
				const detail = findTrackInfo(details, item);
				const track = detail?.track;
				const carrier = firstNumber(item.w1, track?.w1);
				const lastMileCarrier = firstNumber(item.w2, track?.w2);
				const originCountry = firstNumber(item.b, track?.b);
				const destinationCountry = firstNumber(item.c, track?.c);
				const packageStatusCode = firstNumber(item.e, track?.e);
				const latestEvent = track?.z0 ?? undefined;
				const upstreamUpdatedAt = toIsoDateTime(item.tt ?? track?.ylt1 ?? latestEvent?.a);

				return {
					type: "upsert" as const,
					key: trackingKey(item.number, carrier),
					upstreamUpdatedAt: upstreamUpdatedAt ?? undefined,
					icon: packageStatusIcon(packageStatusCode),
					properties: {
						Name: Builder.title(item.number),
						"Tracking Key": Builder.richText(trackingKey(item.number, carrier)),
						"Tracking Number": Builder.richText(item.number),
						"17TRACK URL": Builder.url(trackingUrl(item.number)),
						"Package Status": Builder.select(packageStatusName(packageStatusCode)),
						"Tracking Status": Builder.select(trackingStatusName(track?.is1)),
						"Tracking Active": Builder.checkbox(item.ts ?? true),
						"Carrier Code": optionalNumber(carrier),
						"Last-mile Carrier Code": optionalNumber(lastMileCarrier),
						"Origin Country Code": optionalNumber(originCountry),
						"Destination Country Code": optionalNumber(destinationCountry),
						"Registered At": optionalDateTime(item.rt),
						"Last Tracked At": optionalDateTime(item.tt ?? track?.ylt1),
						"Last Pushed At": optionalDateTime(item.pt),
						"Stopped At": optionalDateTime(item.st),
						"Stop Reason": Builder.select(stopReasonName(item.sr)),
						"Can Retrack": Builder.checkbox(item.ir ?? false),
						"Carrier Changes": optionalNumber(item.mc),
						"Push HTTP Status": optionalNumber(item.ps),
						Tag: Builder.richText(item.tag ?? detail?.tag ?? ""),
						"Latest Event At": optionalDateTime(latestEvent?.a),
						"Latest Event Location": Builder.richText(latestEvent?.c ?? ""),
						"Latest Event": Builder.richText(latestEvent?.z ?? track?.yt ?? ""),
					},
				};
			}),
			hasMore: true,
			nextState: { page: page + 1 },
		};
	},
});

worker.tool("addTrackingNumber", {
	title: "Add 17TRACK Tracking Number",
	description:
		"Register a package tracking number with 17TRACK so it is tracked and synced into the 17TRACK Shipments database.",
	schema: j.object({
		trackingNumber: j.string().describe("Package tracking number to register."),
		carrierCode: j
			.integer()
			.nullable()
			.describe("Optional 17TRACK carrier code. Use null to let 17TRACK detect the carrier."),
		finalCarrierCode: j
			.integer()
			.nullable()
			.describe("Optional last-mile carrier code for UPU shipments. Use null when not needed."),
		extraParam: j
			.string()
			.nullable()
			.describe("Optional carrier-required extra parameter, such as postcode, order date, or phone suffix."),
		tag: j
			.string()
			.nullable()
			.describe("Optional label stored in 17TRACK, such as order ID, vendor, or item name."),
		autoDetection: j
			.boolean()
			.nullable()
			.describe("Whether 17TRACK should try automatic carrier detection when carrierCode is null."),
	}),
	execute: async ({ trackingNumber, carrierCode, finalCarrierCode, extraParam, tag, autoDetection }) => {
		const request: Record<string, string | number | boolean> = {
			number: trackingNumber.trim(),
		};

		if (carrierCode !== null) request.carrier = carrierCode;
		if (finalCarrierCode !== null) request.final_carrier = finalCarrierCode;
		if (extraParam?.trim()) request.extra_param = extraParam.trim();
		if (tag?.trim()) request.tag = tag.trim();
		if (autoDetection !== null) request.auto_detection = autoDetection;

		await TRACK17_RATE_LIMIT.wait();
		const response = await callTrack17<BatchResponse<RegisterAcceptedItem>>("/register", [request]);
		const accepted = response.data.accepted ?? [];
		const rejected = response.data.rejected ?? [];

		return {
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

async function getTrackedShipmentsPage(page: number): Promise<TrackListItem[]> {
	await TRACK17_RATE_LIMIT.wait();
	const response = await callTrack17<BatchResponse<TrackListItem>>("/gettracklist", {
		page_no: page,
		tracking_state: 1,
	});

	return response.data.accepted ?? [];
}

async function getTrackInfoFor(items: TrackListItem[]): Promise<TrackInfoItem[]> {
	const chunks = chunk(items, 40);
	const results: TrackInfoItem[] = [];

	for (const chunkItems of chunks) {
		await TRACK17_RATE_LIMIT.wait();
		const response = await callTrack17<BatchResponse<TrackInfoItem>>(
			"/gettrackinfo",
			chunkItems.map((item) => ({
				number: item.number,
				...(item.w1 ? { carrier: item.w1 } : {}),
			})),
		);
		results.push(...(response.data.accepted ?? []));
	}

	return results;
}

async function callTrack17<T>(path: string, body: unknown): Promise<ApiEnvelope<T>> {
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
		throw new RateLimitError({ retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined });
	}

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`17TRACK ${path} failed with HTTP ${response.status}: ${text}`);
	}

	const parsed = JSON.parse(text) as ApiEnvelope<T>;
	if (parsed.code !== 0) {
		throw new Error(`17TRACK ${path} failed with API code ${parsed.code}: ${text}`);
	}

	return parsed;
}

function findTrackInfo(details: TrackInfoItem[], item: TrackListItem): TrackInfoItem | undefined {
	const expectedKey = trackingKey(item.number, item.w1);
	return (
		details.find((detail) => trackingKey(detail.number, detail.track?.w1) === expectedKey) ??
		details.find((detail) => detail.number === item.number)
	);
}

function trackingKey(number: string, carrier?: number): string {
	return carrier ? `${number}:${carrier}` : number;
}

function trackingUrl(number: string): string {
	return `https://www.17track.net/en/track-details?nums=${encodeURIComponent(number)}`;
}

function packageStatusName(code?: number): string {
	switch (code) {
		case 0:
			return "Not found";
		case 10:
			return "In transit";
		case 20:
			return "Expired";
		case 30:
			return "Pick up";
		case 35:
			return "Undelivered";
		case 40:
			return "Delivered";
		case 50:
			return "Alert";
		default:
			return "Unknown";
	}
}

function trackingStatusName(code?: number): string {
	switch (code) {
		case 0:
			return "Unable to track";
		case 1:
			return "Normal tracking";
		case 2:
			return "Not found";
		case 10:
			return "Web error";
		case 11:
			return "Process error";
		case 12:
			return "Service error";
		case 20:
			return "Web error (cache)";
		case 21:
			return "Process error (cache)";
		case 22:
			return "Service error (cache)";
		default:
			return "Unknown";
	}
}

function stopReasonName(code?: number): string {
	switch (code) {
		case 1:
			return "Expiration rules";
		case 2:
			return "API request";
		case 3:
			return "Manual operation";
		case 4:
			return "Invalid carrier";
		default:
			return "None";
	}
}

function packageStatusIcon(code?: number) {
	switch (code) {
		case 40:
			return Builder.emojiIcon("✅");
		case 50:
		case 35:
			return Builder.emojiIcon("⚠️");
		case 10:
		case 30:
			return Builder.emojiIcon("🚚");
		default:
			return Builder.emojiIcon("📦");
	}
}

function optionalNumber(value?: number) {
	return typeof value === "number" && Number.isFinite(value) ? Builder.number(value) : Builder.richText("");
}

function optionalDateTime(value?: string) {
	const iso = toIsoDateTime(value);
	return iso ? Builder.dateTime(iso, "UTC") : Builder.richText("");
}

function toIsoDateTime(value?: string): string | null {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.startsWith("2079-01-01")) return null;

	const dateTimeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/);
	if (dateTimeMatch) return `${dateTimeMatch[1]}T${dateTimeMatch[2]}:00Z`;

	const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
	if (dateMatch) return `${dateMatch[1]}T00:00:00Z`;

	return null;
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
	return values.find((value) => typeof value === "number" && Number.isFinite(value));
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}
