// Handing a file to the browser, and taking one back. Both are three lines of
// boilerplate that were about to be written twice.

export function saveFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Revoked on a later turn of the event loop, or the download never starts.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// The text of whatever a file input was given. The input belongs to whoever
// owns the control, so it can be reached and tested; this only reads it.
export function readFile(input) {
  return new Promise((resolve) => {
    const file = input.files && input.files[0];
    if (!file) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}
