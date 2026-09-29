export class MultipartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MultipartError';
  }
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let offset = 0;
  let index = buffer.indexOf(separator, offset);
  while (index !== -1) {
    parts.push(buffer.subarray(offset, index));
    offset = index + separator.length;
    index = buffer.indexOf(separator, offset);
  }
  parts.push(buffer.subarray(offset));
  return parts;
}

export function parseMultipart(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]?.trim();
  if (!boundary || boundary.length > 200) throw new MultipartError('invalid multipart boundary');

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  let photo = null;

  for (const rawPart of splitBuffer(body, delimiter).slice(1)) {
    let part = rawPart;
    if (part.subarray(0, 2).equals(Buffer.from('\r\n'))) part = part.subarray(2);
    if (part.subarray(0, 2).equals(Buffer.from('--'))) break;
    if (part.subarray(-2).equals(Buffer.from('\r\n'))) part = part.subarray(0, -2);

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) continue;
    const headers = part.subarray(0, headerEnd).toString('utf8');
    const value = part.subarray(headerEnd + 4);
    const name = /name="([^"]+)"/i.exec(headers)?.[1];
    if (!name) continue;

    if (name === 'photo') {
      photo = {
        bytes: Buffer.from(value),
        filename: /filename="([^"]*)"/i.exec(headers)?.[1] || 'photo.jpg',
        mimeType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase() || '',
      };
    } else {
      fields[name] = value.toString('utf8');
    }
  }

  if (!photo) throw new MultipartError('photo field is required');
  return { fields, photo };
}
