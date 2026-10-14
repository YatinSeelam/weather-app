import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMonitorEmail, ResendEmailProvider, sendWithResend, summarizeUpdate, type EmailMessage } from "../email";
import { looksLikeEmail, splitEmailList } from "../email-list";
import type { MonitorUpdate } from "../notifications";

const update = (overrides: Partial<MonitorUpdate> = {}): MonitorUpdate => ({
  monitor: {
    id: "m1",
    name: "Saugerties, NY · 100 mi",
    zipCode: "12477",
    radiusMiles: 100,
    intervalMinutes: 15,
    emails: ["ops@example.com", "second@example.org"],
    emailMode: "every-check",
  },
  run: {
    status: "ok",
    activeRiskCount: 1,
    highestSeverity: "critical",
    errorSummary: null,
    completedAt: "2026-10-06T20:00:00Z",
  },
  changes: [
    {
      change: "NEW",
      key: "urn:oid:tornado-1",
      kind: "official-alert",
      title: "Tornado Warning",
      detail: "Ulster, NY <b>bold</b>",
      level: "critical",
    },
  ],
  activeRisks: [
    { key: "urn:oid:tornado-1", kind: "official-alert", title: "Tornado Warning", detail: "Ulster, NY", level: "critical" },
  ],
  ...overrides,
});

describe("email address lists", () => {
  it("splits on commas, semicolons and whitespace and removes duplicates", () => {
    expect(splitEmailList(" A@x.com, b@y.org;c@z.net\n a@x.com ")).toEqual(["a@x.com", "b@y.org", "c@z.net"]);
    expect(splitEmailList("")).toEqual([]);
  });

  it("recognises an address loosely", () => {
    expect(looksLikeEmail("ops@example.com")).toBe(true);
    expect(looksLikeEmail("ops@example")).toBe(false);
    expect(looksLikeEmail("not an email")).toBe(false);
  });
});

describe("monitor email", () => {
  it("summarises the run for the subject line", () => {
    expect(summarizeUpdate(update())).toBe("1 active risk, highest critical");
    expect(summarizeUpdate(update({ run: { ...update().run, activeRiskCount: 0, highestSeverity: null } }))).toBe(
      "No active weather risks",
    );
    expect(summarizeUpdate(update({ run: { ...update().run, status: "failed" } }))).toBe("Unable to check live weather");
  });

  it("addresses every recipient and lists changes and active risks", () => {
    const message = renderMonitorEmail(update(), "Weather Monitor <alerts@example.com>");
    expect(message.from).toBe("Weather Monitor <alerts@example.com>");
    expect(message.to).toEqual(["ops@example.com", "second@example.org"]);
    expect(message.subject).toBe("Saugerties, NY · 100 mi: 1 active risk, highest critical");
    expect(message.text).toContain("Changed since the last check:\n- Tornado Warning (New, critical): Ulster, NY");
    expect(message.text).toContain("Active now:\n- Tornado Warning (critical): Ulster, NY");
    expect(message.text).toContain("every 15 min");
  });

  it("escapes alert text in the HTML body", () => {
    const { html } = renderMonitorEmail(update());
    expect(html).toContain("Ulster, NY &lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });

  it("says plainly when the check failed or nothing is active", () => {
    const failed = renderMonitorEmail(
      update({ run: { ...update().run, status: "failed", errorSummary: "NWS returned 503." }, changes: [], activeRisks: [] }),
    );
    expect(failed.text).toContain("The check could not be completed: NWS returned 503. This is not an all-clear.");
    expect(failed.text).toContain("Nothing changed.");
    expect(failed.text).toContain("Active now:\nNone.");
  });
});

describe("Resend provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends nothing for a monitor without recipients", async () => {
    const send = vi.fn<(message: EmailMessage) => Promise<void>>();
    await new ResendEmailProvider(send).notify(update({ monitor: { ...update().monitor, emails: [] } }));
    expect(send).not.toHaveBeenCalled();
  });

  it("sends one rendered message per update", async () => {
    const send = vi.fn<(message: EmailMessage) => Promise<void>>().mockResolvedValue();
    await new ResendEmailProvider(send).notify(update());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toEqual(["ops@example.com", "second@example.org"]);
  });

  it("posts to Resend with the API key and surfaces API errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "email_1" }))
      .mockResolvedValueOnce(Response.json({ message: "Invalid `from` field" }, { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    const message = renderMonitorEmail(update(), "Weather Monitor <alerts@example.com>");

    await sendWithResend(message, "re_test_key");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    expect(JSON.parse(init?.body as string)).toMatchObject({ to: message.to, subject: message.subject });

    await expect(sendWithResend(message, "re_test_key")).rejects.toThrow("Resend returned 422: Invalid `from` field");
    await expect(sendWithResend(message, null)).rejects.toThrow("RESEND_API_KEY is not set.");
  });
});
