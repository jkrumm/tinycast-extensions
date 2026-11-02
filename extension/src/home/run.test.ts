import { describe, expect, it, vi } from "vitest";
import {
  HomeStore,
  StatusStore,
  fetchDoctor,
  loadMenuBar,
  namiPresence,
  refreshHome,
  refreshStatus,
  triggerScene,
} from "./run";
import { HomeCache, StatusCache } from "./types";

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

const statusOut =
  '{"climate":{"sensor":"Eve","reachable":true,"temperature_c":21.9,"humidity_pct":42,"battery_pct":100},"nami_home":true,"someone_home":true}';

function memoryStatusStore(initial: StatusCache | null) {
  let value = initial;
  const store: StatusStore = {
    read: async () => value,
    write: vi.fn(async (v: StatusCache) => {
      value = v;
    }),
  };
  return store;
}

describe("refreshStatus + namiPresence", () => {
  it("parses and caches one status call", async () => {
    const store = memoryStatusStore(null);
    const run = vi.fn(route({ status: statusOut }));
    const got = await refreshStatus(store, run, 5);
    expect(run).toHaveBeenCalledWith(["status", "--json"]);
    expect(got.fetchedAt).toBe(5);
    expect(got.status.climate?.temperatureC).toBe(21.9);
    expect(store.write).toHaveBeenCalledWith(got);
  });

  it("fills holes from the cached reading", async () => {
    const store = memoryStatusStore({
      status: {
        climate: {
          sensor: "Eve",
          reachable: true,
          temperatureC: 20,
          humidityPct: 50,
          batteryPct: 90,
        },
        namiHome: false,
        someoneHome: true,
      },
      fetchedAt: 1,
    });
    const got = await refreshStatus(
      store,
      route({
        status:
          '{"climate":{"reachable":false,"temperature_c":null},"nami_home":null,"someone_home":null}',
      }),
      2,
    );
    expect(got.status.climate).toMatchObject({
      reachable: false,
      temperatureC: 20,
      humidityPct: 50,
    });
    expect(got.status.namiHome).toBe(false);
  });

  it("rejects, writing nothing, on failure or unreadable output", async () => {
    const store = memoryStatusStore(null);
    await expect(
      refreshStatus(store, route({ status: new Error("ssh") })),
    ).rejects.toThrow("ssh");
    await expect(
      refreshStatus(store, route({ status: "oops" })),
    ).rejects.toThrow(/unreadable/);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("sets the Nami switch by value", async () => {
    const run = vi.fn(async () => "");
    await namiPresence(true, run);
    expect(run).toHaveBeenCalledWith(["set", "Nami zu Hause", "power", "true"]);
    await namiPresence(false, run);
    expect(run).toHaveBeenLastCalledWith([
      "set",
      "Nami zu Hause",
      "power",
      "false",
    ]);
  });
});

describe("loadMenuBar", () => {
  const scenes = [{ id: "A1", name: "Chill", rooms: [], actionCount: 2 }];
  const freshHome: HomeCache = { scenes, doctor: null, fetchedAt: 1000 };

  it("uses fresh cached scenes and fetches only status", async () => {
    const run = vi.fn(route({ status: statusOut }));
    const got = await loadMenuBar(
      memoryStatusStore(null),
      memoryStore(freshHome),
      run,
      2000,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(got.error).toBeNull();
    expect(got.scenes).toBe(scenes);
    expect(got.status?.status.namiHome).toBe(true);
  });

  it("fetches and stores scenes when the cache is missing", async () => {
    const homeStore = memoryStore(null);
    const got = await loadMenuBar(
      memoryStatusStore(null),
      homeStore,
      route({ status: statusOut, scenes: scenesOut }),
      3,
    );
    expect(got.scenes).toHaveLength(1);
    expect(homeStore.write).toHaveBeenCalled();
  });

  it("keeps the last-known status and reports a friendly error", async () => {
    const cached: StatusCache = {
      status: { climate: null, namiHome: true, someoneHome: true },
      fetchedAt: 1,
    };
    const got = await loadMenuBar(
      memoryStatusStore(cached),
      memoryStore(freshHome),
      route({ status: new Error("home: HomeClaw unreachable") }),
      2000,
    );
    expect(got.status).toBe(cached);
    expect(got.scenes).toBe(scenes);
    expect(got.error).toMatch(/mini online/);
  });
});
