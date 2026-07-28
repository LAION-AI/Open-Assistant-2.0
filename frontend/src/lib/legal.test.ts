import { describe, expect, test } from "bun:test";
import {
  getLegalDoc,
  LEGAL_SLUGS,
  TERMS_VERSION,
  DATASET_CONSENT_VERSION,
  DATASET_CONSENT_TEXT,
} from "./legal";

describe("legal documents", () => {
  test("every advertised slug resolves to a document", () => {
    for (const slug of LEGAL_SLUGS) {
      const doc = getLegalDoc(slug);
      expect(doc).not.toBeNull();
      expect(doc!.markdown.length).toBeGreaterThan(500);
      expect(doc!.title.length).toBeGreaterThan(0);
    }
  });

  test("unknown slugs return null rather than throwing", () => {
    expect(getLegalDoc("nope")).toBeNull();
    // Path traversal must not escape the legal directory.
    expect(getLegalDoc("../package.json")).toBeNull();
    expect(getLegalDoc("../../.env")).toBeNull();
  });

  test("the Impressum carries the statutory disclosures", () => {
    const md = getLegalDoc("impressum")!.markdown;
    for (const required of ["LAION", "Marlowring 26", "22525 Hamburg", "VR 25085", "contact@laion.ai"]) {
      expect(md).toContain(required);
    }
  });

  test("terms and privacy are versioned, the Impressum is not", () => {
    expect(getLegalDoc("terms")!.version).toBe(TERMS_VERSION);
    expect(getLegalDoc("privacy")!.version).toBe(TERMS_VERSION);
    // No consent attaches to a statutory disclosure, so there is nothing to version.
    expect(getLegalDoc("impressum")!.version).toBeUndefined();
  });

  test("the privacy policy states the consent basis and the limit of withdrawal", () => {
    const md = getLegalDoc("privacy")!.markdown;
    expect(md).toContain("CC-BY 4.0");
    expect(md).toContain("Art. 6(1)(a)");
    // The one promise we must never quietly drop: published releases are final.
    expect(md.toLowerCase()).toContain("cannot be recalled");
  });

  test("the consent text names the licence and that it is revocable", () => {
    expect(DATASET_CONSENT_TEXT).toContain("CC-BY 4.0");
    expect(DATASET_CONSENT_TEXT).toContain("withdraw");
    expect(DATASET_CONSENT_VERSION.length).toBeGreaterThan(0);
  });

  test("documents are cached, so repeated reads are the same object", () => {
    expect(getLegalDoc("terms")).toBe(getLegalDoc("terms"));
  });
});
