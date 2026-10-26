import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { chunkPages, CHUNK_TARGET, MAX_CHUNKS_PER_DOCUMENT } from "../src/lib/precon/chunk";
import { parseCsv, SheetLimitError } from "../src/lib/precon/csv";
import { extractContent, ExtractError, readTable, sheetToText } from "../src/lib/precon/extract";
import {
  MAX_UPLOAD_BYTES, checkContent, checkUploadMeta, displayFilename, extOf, storageFilename, storagePath, zipUncompressedSize,
} from "../src/lib/precon/files";
import { JPG_BYTES, PNG_BYTES, makePdf, makeXlsx, utf8 } from "./precon-fixtures";

describe("upload metadata checks (browser and server share them)", () => {
  it("accepts every supported type with its canonical or browser-typical mime", () => {
    for (const [name, mime] of [["a.pdf", "application/pdf"], ["a.JPG", "image/jpeg"], ["a.jpeg", "image/jpeg"], ["a.png", "image/png"], ["a.webp", "image/webp"], ["a.txt", "text/plain"], ["a.csv", "text/csv"], ["a.csv", "application/vnd.ms-excel"], ["a.csv", ""], ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]] as const) {
      assert.equal(checkUploadMeta(name, mime, 1000).ok, true, `${name} ${mime}`);
    }
  });
  it("rejects unsupported types, executables and scriptable images", () => {
    for (const n of ["a.exe", "a.svg", "a.html", "a.docx", "a.xls", "a.zip", "a.js", "noextension", "a.pdf.exe"]) {
      const r = checkUploadMeta(n, "application/octet-stream", 1000);
      assert.equal(r.ok, false, n);
    }
  });
  it("rejects empty and oversized files, and a mime that contradicts the extension", () => {
    assert.deepEqual(checkUploadMeta("a.pdf", "application/pdf", 0).ok, false);
    const big = checkUploadMeta("a.pdf", "application/pdf", MAX_UPLOAD_BYTES + 1);
    assert.ok(!big.ok && big.code === "too_large");
    assert.equal(checkUploadMeta("a.pdf", "image/png", 10).ok, false);
    assert.equal(checkUploadMeta("a.pdf", "application/pdf", MAX_UPLOAD_BYTES).ok, true);
  });
  it("refuses to file a spreadsheet as a rendering", () => {
    assert.equal(checkUploadMeta("a.xlsx", "", 100, "rendering").ok, false);
    assert.equal(checkUploadMeta("a.png", "image/png", 100, "rendering").ok, true);
  });
});

describe("content checks use the bytes, not the name", () => {
  it("accepts real signatures", () => {
    assert.ok(checkContent("pdf", makePdf(["hello"])).ok);
    assert.ok(checkContent("png", PNG_BYTES).ok);
    assert.ok(checkContent("jpg", JPG_BYTES).ok);
    assert.ok(checkContent("xlsx", makeXlsx([["a"]])).ok);
    assert.ok(checkContent("txt", utf8("plain")).ok);
  });
  it("rejects a renamed file", () => {
    assert.equal(checkContent("pdf", PNG_BYTES).ok, false);
    assert.equal(checkContent("png", makePdf(["x"])).ok, false);
    assert.equal(checkContent("xlsx", utf8("not a zip")).ok, false);
    assert.equal(checkContent("jpg", utf8("<script>alert(1)</script>")).ok, false);
    assert.equal(checkContent("txt", Uint8Array.from([0x4d, 0x5a, 0, 0, 3, 0])).ok, false); // MZ executable header with NULs
    assert.equal(checkContent("pdf", new Uint8Array(0)).ok, false);
  });
});

describe("filenames and storage paths", () => {
  it("cannot escape the project folder", () => {
    for (const evil of ["../../etc/passwd", "..\\..\\windows\\system32\\x.pdf", "a/b/c.pdf", "  ..  ", "\u0000bad.pdf", "über straße (1).pdf"]) {
      const p = storagePath("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", evil);
      assert.match(p, /^projects\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/, evil);
      assert.ok(!p.includes(".."), evil);
    }
  });
  it("keeps a lowercase extension and handles duplicates by giving every upload its own folder", () => {
    assert.equal(storageFilename("Floor Plan A.PDF"), "Floor_Plan_A.pdf");
    const a = storagePath("11111111-1111-1111-1111-111111111111", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "brochure.pdf");
    const b = storagePath("11111111-1111-1111-1111-111111111111", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "brochure.pdf");
    assert.notEqual(a, b);
  });
  it("display names drop paths and control characters but keep the user's wording", () => {
    assert.equal(displayFilename("C:\\Users\\me\\Lakeview Brochure.pdf"), "Lakeview Brochure.pdf");
    assert.equal(displayFilename("a\u0007b.pdf"), "ab.pdf");
    assert.equal(extOf("x.JPEG"), "jpg");
  });
});

describe("csv parser", () => {
  it("handles quotes, embedded commas and newlines, CRLF, a BOM and blank lines", () => {
    const rows = parseCsv('\ufeffName,Note\r\n"Smith, J","line1\nline2"\r\n\r\n"He said ""hi""",x\r\n');
    assert.deepEqual(rows, [["Name", "Note"], ["Smith, J", "line1\nline2"], ['He said "hi"', "x"]]);
  });
  it("detects semicolon and tab delimiters", () => {
    assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  });
  it("enforces limits instead of exhausting memory", () => {
    assert.throws(() => parseCsv("a\n".repeat(20_005)), SheetLimitError);
    assert.throws(() => parseCsv(Array.from({ length: 101 }, (_, i) => `c${i}`).join(",")), SheetLimitError);
    assert.throws(() => parseCsv(`"${"x".repeat(2001)}"`), SheetLimitError);
  });
});

describe("chunking keeps the page", () => {
  it("splits long pages with overlap and never loses the page number", () => {
    const sentence = "The building offers a rooftop terrace with city views. ";
    const { chunks } = chunkPages([{ page: 1, text: sentence.repeat(60) }, { page: 2, text: "Short page two." }]);
    assert.ok(chunks.length > 2);
    assert.ok(chunks.every((c) => c.text.length <= CHUNK_TARGET));
    assert.deepEqual([...new Set(chunks.map((c) => c.page))], [1, 2]);
    assert.equal(chunks.at(-1)!.text, "Short page two.");
  });
  it("is bounded", () => {
    const { chunks, truncated } = chunkPages([{ page: null, text: "word ".repeat(2_000_000) }]);
    assert.equal(chunks.length, MAX_CHUNKS_PER_DOCUMENT);
    assert.equal(truncated, true);
  });
  it("returns nothing for blank input", () => {
    assert.deepEqual(chunkPages([{ page: 1, text: "  \n\u0000 " }]).chunks, []);
  });
});

describe("extraction from real files", () => {
  it("reads text per page from a real PDF", async () => {
    const out = await extractContent("pdf", makePdf(["Lakeview Towers brochure", "Two bedroom suites from the 12th floor"]));
    assert.equal(out.kind, "text");
    assert.equal(out.page_count, 2);
    assert.deepEqual(out.pages.map((p) => p.page), [1, 2]);
    assert.match(out.pages[1].text, /Two bedroom suites/);
  });
  it("reports a scanned (textless) PDF as no_text instead of pretending it is searchable", async () => {
    await assert.rejects(extractContent("pdf", makePdf(["", ""])), (e: unknown) => e instanceof ExtractError && e.code === "no_text");
  });
  it("reports a corrupt PDF with a fixed message that does not echo content", async () => {
    await assert.rejects(extractContent("pdf", utf8("%PDF-1.4 garbage SECRET-PRICE-123")), (e: unknown) => e instanceof ExtractError && e.code === "extract_failed" && !e.message.includes("SECRET"));
  });
  it("turns a real XLSX into one searchable line per row with its column names", async () => {
    const x = makeXlsx([["Unit", "Type", "Price", "Status"], ["1204", "2 Bed", 799000, "Available"], ["1205", "1 Bed", 599000, "Sold"]]);
    const out = await extractContent("xlsx", x);
    assert.match(out.pages[0].text, /Inventory, row 2: Unit: 1204; Type: 2 Bed; Price: 799000; Status: Available/);
    assert.match(out.pages[0].text, /row 3: Unit: 1205/);
  });
  it("turns CSV into the same row lines, and plain text into one page", async () => {
    const csv = await extractContent("csv", utf8("Unit,Price\n1204,799000\n"));
    assert.match(csv.pages[0].text, /Sheet, row 2: Unit: 1204; Price: 799000/);
    const txt = await extractContent("txt", utf8("A short note about the project."));
    assert.equal(txt.pages[0].page, null);
  });
  it("stores images but does not claim to read them", async () => {
    const out = await extractContent("png", PNG_BYTES);
    assert.deepEqual(out, { kind: "image", pages: [], page_count: null });
  });
  it("rejects empty text", async () => {
    await assert.rejects(extractContent("txt", utf8("   \n")), (e: unknown) => e instanceof ExtractError && e.code === "no_text");
  });
  it("refuses a zip bomb by its declared size before inflating anything", async () => {
    const bomb = zipSync({ "xl/worksheets/sheet1.xml": strToU8("<a>" + "0".repeat(1000) + "</a>") });
    assert.ok((zipUncompressedSize(bomb) ?? 0) > 1000);
    // Patch the central directory's claimed uncompressed size to 500 MB.
    const dv = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    for (let i = 0; i < bomb.byteLength - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 500 * 1024 * 1024, true);
    await assert.rejects(extractContent("xlsx", bomb), (e: unknown) => e instanceof ExtractError && e.code === "too_complex");
  });
  it("rejects a corrupt zip", async () => {
    await assert.rejects(extractContent("xlsx", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])), (e: unknown) => e instanceof ExtractError);
  });
});

describe("readTable and sheetToText", () => {
  it("finds the header row after blank rows and skips empty cells", () => {
    assert.equal(sheetToText("S", [[null, null], ["A", "B"], ["1", ""], ["", "2"]]), "S, row 3: A: 1\nS, row 4: B: 2");
  });
  it("reads the first non-empty sheet of an xlsx and a csv as raw rows", async () => {
    const x = await readTable("xlsx", makeXlsx([["Unit", "Price"], ["1", 5]]));
    assert.deepEqual(x.rows, [["Unit", "Price"], ["1", 5]]);
    assert.equal(x.sheet, "Inventory");
    assert.deepEqual((await readTable("csv", utf8("a,b\n1,2"))).rows, [["a", "b"], ["1", "2"]]);
  });
});
