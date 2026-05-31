import type {PlaudApiClient, PlaudFileSummary} from './plaud-api';
import type {NormalizedPlaudDetail} from './plaud-normalizer';
import type {PlaudVaultAdapter, UpsertPlaudNoteResult} from './plaud-vault';

export interface PlaudSyncSettings {
	syncFolder: string;
	filenamePattern: string;
	updateExisting: boolean;
	lastSyncAtMs: number;
}

export interface PlaudSyncFailure {
	fileId: string;
	message: string;
}

export interface PlaudSyncSummary {
	listed: number;
	selected: number;
	created: number;
	updated: number;
	skipped: number;
	failed: number;
	transcribed: number;
	lastSyncAtMsBefore: number;
	lastSyncAtMsAfter: number;
	failures: PlaudSyncFailure[];
}

export interface RunPlaudSyncInput {
	api: PlaudApiClient;
	vault: PlaudVaultAdapter;
	settings: PlaudSyncSettings;
	saveCheckpoint: (nextLastSyncAtMs: number) => Promise<void>;
	normalizeDetail: (raw: unknown) => NormalizedPlaudDetail;
	renderMarkdown: (detail: NormalizedPlaudDetail) => string;
	downloadAudio: (fileId: string) => Promise<ArrayBuffer>;
	createBinary: (path: string, data: ArrayBuffer) => Promise<void>;
	enableTranscription: boolean;
	transcribeAudio: (audioData: ArrayBuffer, fileName: string) => Promise<string>;
	upsertNote: (input: {
		vault: PlaudVaultAdapter;
		syncFolder: string;
		filenamePattern: string;
		updateExisting: boolean;
		fileId: string;
		title: string;
		date: string;
		markdown: string;
	}) => Promise<UpsertPlaudNoteResult>;
}

function normalizeTimestampMs(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return 0;
	}

	return Math.floor(value);
}

function normalizeBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') {
		return value;
	}

	if (typeof value === 'number') {
		return value !== 0;
	}

	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		return normalized === '1' || normalized === 'true' || normalized === 'yes';
	}

	return false;
}

function formatDate(timestampMs: number): string {
	if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
		return '1970-01-01';
	}

	return new Date(timestampMs).toISOString().slice(0, 10);
}

function resolveFileId(summary: PlaudFileSummary): string {
	const preferred = typeof summary.file_id === 'string' ? summary.file_id.trim() : '';
	return preferred || summary.id;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return 'Unknown sync error.';
}

export function isTrashedFile(summary: PlaudFileSummary): boolean {
	return normalizeBoolean(summary.is_trash);
}

export function shouldSyncFile(summary: PlaudFileSummary, lastSyncAtMs: number): boolean {
	if (isTrashedFile(summary)) {
		return false;
	}

	const checkpoint = normalizeTimestampMs(lastSyncAtMs);
	if (checkpoint === 0) {
		return true;
	}

	const startAtMs = normalizeTimestampMs(summary.start_time);
	if (startAtMs === 0) {
		return true;
	}

	return startAtMs > checkpoint;
}

export async function runPlaudSync(input: RunPlaudSyncInput): Promise<PlaudSyncSummary> {
	const checkpointBefore = normalizeTimestampMs(input.settings.lastSyncAtMs);
	const listed = await input.api.listFiles();
	const selected = listed.filter((summary) => shouldSyncFile(summary, checkpointBefore));

	let created = 0;
	let updated = 0;
	let skipped = 0;
	let failed = 0;
	let transcribed = 0;
	let checkpointCandidate = checkpointBefore;
	const failures: PlaudSyncFailure[] = [];

	for (const summary of selected) {
		const fileId = resolveFileId(summary);

		try {
			const detail = await input.api.getFileDetail(fileId);
			const normalized = input.normalizeDetail(detail);
			const markdown = input.renderMarkdown(normalized);
			const upsertResult = await input.upsertNote({
				vault: input.vault,
				syncFolder: input.settings.syncFolder,
				filenamePattern: input.settings.filenamePattern,
				updateExisting: input.settings.updateExisting,
				fileId: normalized.fileId,
				title: normalized.title,
				date: formatDate(normalized.startAtMs),
				markdown
			});

			if (upsertResult.action === 'created') {
				created += 1;
			} else if (upsertResult.action === 'updated') {
				updated += 1;
			} else {
				skipped += 1;
			}

			let audioData: ArrayBuffer | null = null;

			try {
				audioData = await input.downloadAudio(fileId);
				const audioFolder = `${input.settings.syncFolder}/audio`;
				await input.vault.ensureFolder(audioFolder);
				const audioPath = `${audioFolder}/plaud-audio-${fileId}.ogg`;
				await input.createBinary(audioPath, audioData);
			} catch {
				// best-effort audio download
			}

			if (audioData && !normalized.transcript && input.enableTranscription) {
				try {
					const transcript = await input.transcribeAudio(audioData, `plaud-audio-${fileId}.ogg`);
					normalized.transcript = transcript;
					const updatedMarkdown = input.renderMarkdown(normalized);
					await input.vault.write(upsertResult.path, updatedMarkdown);
					transcribed += 1;
				} catch {
					// best-effort transcription
				}
			}

			checkpointCandidate = Math.max(
				checkpointCandidate,
				normalizeTimestampMs(summary.start_time),
				normalizeTimestampMs(normalized.startAtMs)
			);
		} catch (error) {
			failed += 1;
			failures.push({
				fileId,
				message: toErrorMessage(error)
			});
		}
	}

	let checkpointAfter = checkpointBefore;
	if (failed === 0 && checkpointCandidate > checkpointBefore) {
		await input.saveCheckpoint(checkpointCandidate);
		checkpointAfter = checkpointCandidate;
	}

	return {
		listed: listed.length,
		selected: selected.length,
		created,
		updated,
		skipped,
		failed,
		transcribed,
		lastSyncAtMsBefore: checkpointBefore,
		lastSyncAtMsAfter: checkpointAfter,
		failures
	};
}
