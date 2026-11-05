// 最小的 ZIP 打包器（store 模式，不压缩）。
//
// 不引第三方依赖：我们只需要把少量文本与图片放进一个可下载的包，
// store 模式（compression method 0）足够，且实现完全可控、无原生编译。
import { createHash } from "node:crypto";

export interface ZipEntry {
  /** 包内路径，例如 `正文.html`。 */
  name: string;
  bytes: Uint8Array;
  /** 固定为 2026-11-05 之前的时间会让 zip 工具报错，这里统一用打包时刻。 */
  mtime?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) & 0x7f) << 9 | ((date.getMonth() + 1) & 0x0f) << 5 | (date.getDate() & 0x1f);
  return { time, date: day };
}

/** 把若干文件打成 zip。同名条目按出现顺序后者覆盖前者，避免包里出现重复路径。 */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const seen = new Map<string, ZipEntry>();
  for (const entry of entries) seen.set(entry.name, entry);
  const files = [...seen.values()];

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.bytes);
    const crc = crc32(data);
    const when = dosDateTime(file.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 文件名 UTF-8
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(when.time, 10);
    local.writeUInt16LE(when.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // 中央目录头
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(when.time, 12);
    header.writeUInt16LE(when.date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...chunks, centralBuffer, end]));
}

/** 包清单：每个文件的相对路径、字节数与 sha256，用于复核包内容没被改过。 */
export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export function fileManifest(entries: readonly ZipEntry[]): ManifestFile[] {
  return [...entries]
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .map((entry) => ({
      path: entry.name,
      bytes: entry.bytes.byteLength,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    }));
}
