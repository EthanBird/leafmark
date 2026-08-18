import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export const MAX_XML_BYTES = 96 * 1024 * 1024;

export type OfficePackage = Record<string, Uint8Array>;

export function unzipPackage(buffer: ArrayBuffer, filter?: (name: string) => boolean): OfficePackage {
  let expandedBytes = 0;
  return unzipSync(new Uint8Array(buffer), {
    filter(file) {
      if (filter && !filter(file.name)) return false;
      expandedBytes += file.originalSize;
      if (expandedBytes > MAX_XML_BYTES && /\.xml$/i.test(file.name)) {
        throw new Error("文档 XML 超过 96 MB，已停止解析以保护内存");
      }
      return true;
    },
  });
}

export function zipPackage(files: OfficePackage): Uint8Array {
  return zipSync(files, { level: 6 });
}

export function packageText(files: OfficePackage, name: string, required = true) {
  const file = files[name] ?? files[name.replace(/\\/g, "/")];
  if (!file) {
    if (required) throw new Error(`文档结构不完整：缺少 ${name}`);
    return "";
  }
  return strFromU8(file);
}

export function setPackageText(files: OfficePackage, name: string, xml: string) {
  files[name] = strToU8(xml);
}

export function clonePackage(files: OfficePackage): OfficePackage {
  const clone: OfficePackage = {};
  for (const [name, bytes] of Object.entries(files)) clone[name] = bytes.slice();
  return clone;
}

export function findPackagePart(files: OfficePackage, pattern: RegExp) {
  return Object.keys(files).filter((name) => pattern.test(name)).sort();
}
