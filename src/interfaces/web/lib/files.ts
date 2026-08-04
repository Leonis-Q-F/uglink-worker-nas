export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: 'application/json;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function readJsonFile<T>(file: File, maximumBytes = 1_048_576): Promise<T> {
  if (file.size > maximumBytes) throw new Error('文件不能超过 1 MiB。');
  try {
    return JSON.parse(await file.text()) as T;
  } catch {
    throw new Error('所选文件不是有效的 JSON。');
  }
}
