import { describe, expect, test } from "bun:test";
import {
  describeOnDeviceProgress,
  formatModelBytes,
  getOnDeviceModel,
  ON_DEVICE_MODELS,
  onDeviceModelFromLogName,
} from "./on-device-models";

describe("on-device model catalog", () => {
  test("exposes the two browser runtimes with stable logging names", () => {
    expect(ON_DEVICE_MODELS.map(model => model.id)).toEqual(["bonsai-27b-q1", "gemma-4-e2b"]);
    expect(getOnDeviceModel("bonsai-27b-q1").logModel).toBe("local/bonsai-27b-q1");
    expect(onDeviceModelFromLogName("local/gemma-4-e2b")?.id).toBe("gemma-4-e2b");
    expect(onDeviceModelFromLogName("remote/model")).toBeNull();
  });

  test("formats decimal download sizes shown by Hugging Face", () => {
    expect(formatModelBytes(3_803_452_480)).toBe("3.80 GB");
    expect(formatModelBytes(2_490_281_472)).toBe("2.49 GB");
  });
});

describe("on-device loading progress", () => {
  test("derives byte progress and labels cached weights", () => {
    expect(
      describeOnDeviceProgress({
        status: "weights",
        kind: "bytes",
        loaded: 250,
        total: 1000,
        fromCache: true,
      }),
    ).toEqual({
      label: "Loading cached weights · 0.00 GB / 0.00 GB",
      fraction: 0.25,
      loadedBytes: 250,
      totalBytes: 1000,
    });
  });

  test("keeps tensor preparation separate from byte progress", () => {
    expect(
      describeOnDeviceProgress({
        status: "weights",
        kind: "tensors",
        message: "Uploading to GPU",
        loaded: 12,
        total: 48,
      }),
    ).toEqual({ label: "Uploading to GPU · 12 / 48" });
  });
});
