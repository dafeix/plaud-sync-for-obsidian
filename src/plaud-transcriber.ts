export interface TranscriptionSettings {
	apiUrl: string;
	apiKey: string;
	model: string;
}

export interface TranscriptionInput {
	audioData: ArrayBuffer;
	fileName: string;
	settings: TranscriptionSettings;
}

function normalizeUrl(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

export async function transcribeAudio(input: TranscriptionInput): Promise<string> {
	const {apiUrl, apiKey, model} = input.settings;

	if (!apiKey.trim()) {
		throw new Error('Transcription API key is not configured.');
	}

	const baseUrl = normalizeUrl(apiUrl);
	const url = `${baseUrl}/audio/transcriptions`;

	const formData = new FormData();
	const blob = new Blob([input.audioData], {type: 'audio/ogg'});
	formData.append('file', blob, input.fileName);
	formData.append('model', model || 'paraformer-v2');

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey.trim()}`
		},
		body: formData
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => 'Unknown error');
		throw new Error(`Transcription failed (HTTP ${response.status}): ${errorText}`);
	}

	const result: unknown = await response.json();

	if (!isRecord(result)) {
		throw new Error('Unexpected transcription response format.');
	}

	const text = firstString([result.text]);

	if (!text) {
		throw new Error('Transcription returned empty text.');
	}

	return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function firstString(values: unknown[]): string {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}

	return '';
}
