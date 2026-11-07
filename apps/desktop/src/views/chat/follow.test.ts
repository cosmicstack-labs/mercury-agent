import { describe, expect, it } from "vitest";
import { jumpLabel } from "./follow";

describe("jumpLabel", () => {
  it("says what happened below while you read further up", () => {
    expect(jumpLabel({ busy: true, unseen: 0, finished: false })).toBe("Mercury is writing");
    expect(jumpLabel({ busy: false, unseen: 1, finished: true })).toBe("1 new message");
    expect(jumpLabel({ busy: true, unseen: 3, finished: false })).toBe("3 new messages");
    expect(jumpLabel({ busy: false, unseen: 0, finished: true })).toBe("Reply finished");
    expect(jumpLabel({ busy: false, unseen: 0, finished: false })).toBe("Jump to latest");
  });
});
