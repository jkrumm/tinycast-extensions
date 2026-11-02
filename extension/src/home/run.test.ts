import { describe, expect, it, vi } from "vitest";
import { HomeStore, fetchDoctor, refreshHome, triggerScene } from "./run";
import { HomeCache } from "./types";

const scenesOut =
  '[{"name":"Chill","id":"A1","rooms":["Wohnzimmer"],"action_count":2}]';
const doctorOut =
  '{"total":1,"unreachable":[],"low_battery":[{"name":"T","room":null,"battery":1}]}';

function memoryStore(initial: HomeCache | null) {
  let value = initial;
  const store: HomeStore = {
    read: async () => value,
    write: vi.fn(async (v: HomeCache) => {
      value = v;
    }),
  };
  return store;
}

const route =
  (answers: Record<string, string | Error>) => async (args: string[]) => {
    const answer = answers[args[0]];
    if (answer instanceof Error) throw answer;
    return answer ?? "";
  };

describe("refreshHome", () => {
  it("fetches scenes and doctor and caches both", async () => {
    const store = memoryStore(null);
    const got = await refreshHome(
      store,
      route({ scenes: scenesOut, doctor: doctorOut }),
      7,
    );
    expect(got.scenes).toHaveLength(1);
    expect(got.doctor?.lowBattery).toHaveLength(1);
    expect(got.fetchedAt).toBe(7);
    expect(store.write).toHaveBeenCalledWith(got);
  });

  it("keeps the cached doctor when doctor fails", async () => {
    const doctor = { total: 3, unreachable: [], lowBattery: [] };
    const store = memoryStore({ scenes: [], doctor, fetchedAt: 1 });
    const got = await refreshHome(
      store,
      route({ scenes: scenesOut, doctor: new Error("ssh") }),
      2,
    );
    expect(got.doctor).toBe(doctor);
  });

  it("rejects, and writes nothing, when scenes fail", async () => {
    const store = memoryStore(null);
    await expect(
      refreshHome(store, route({ scenes: new Error("HomeClaw unreachable") })),
    ).rejects.toThrow(/unreachable/);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("rejects on unreadable scenes output", async () => {
    await expect(
      refreshHome(memoryStore(null), route({ scenes: "oops", doctor: "{}" })),
    ).rejects.toThrow(/unreadable/);
  });
});

describe("fetchDoctor + triggerScene", () => {
  it("fetchDoctor is null on failure", async () => {
    expect(await fetchDoctor(route({ doctor: new Error("x") }))).toBeNull();
  });
  it("triggers by id", async () => {
    const run = vi.fn(async () => "");
    await triggerScene("A1", run);
    expect(run).toHaveBeenCalledWith(["trigger", "A1"]);
  });
});
