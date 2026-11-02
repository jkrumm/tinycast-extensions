import { describe, expect, it, vi } from "vitest";
import {
  HomeStore,
  NamiWriteMarker,
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

function memoryStatusStore(
  initial: StatusCache | null,
  initialMarker: NamiWriteMarker | null = null,
) {
  let value = initial;
  let marker = initialMarker;
  const store: StatusStore = {
    read: async () => value,
    write: vi.fn(async (v: StatusCache) => {
      value = v;
    }),
    readMarker: async () => marker,
    writeMarker: async (m: NamiWriteMarker) => {
      marker = m;
    },
  };
  return store;
}

const clock = (...times: number[]) => {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

describe("refreshStatus + namiPresence", () => {
  it("parses and caches one status call", async () => {
    const store = memoryStatusStore(null);
    const run = vi.fn(route({ status: statusOut }));
    const got = await refreshStatus(store, run, 5);
    expect(run).toHaveBeenCalledWith(["status", "--json"]);
    expect(got?.fetchedAt).toBe(5);
    expect(got?.status.climate?.temperatureC).toBe(21.9);
    expect(store.write).toHaveBeenCalledWith(got);
  });

  it("fills climate holes from an unreachable sensor with its old timestamp, never the switches", async () => {
    const store = memoryStatusStore({
      status: {
        climate: {
          sensor: "Eve",
          reachable: true,
          temperatureC: 20,
          humidityPct: 50,
          batteryPct: 90,
        },
        namiHome: true,
        someoneHome: true,
      },
      fetchedAt: 1,
      climateAt: 1,
    });
    const got = await refreshStatus(
      store,
      route({
        status:
          '{"climate":{"reachable":false,"temperature_c":null},"nami_home":null,"someone_home":null}',
      }),
      2,
    );
    expect(got?.status.climate).toMatchObject({
      reachable: false,
      temperatureC: 20,
      humidityPct: 50,
    });
    expect(got?.fetchedAt).toBe(2);
    expect(got?.climateAt).toBe(1);
    expect(got?.status.namiHome).toBeNull();
    expect(got?.status.someoneHome).toBeNull();
  });

  it("shares one in-flight request within a settled epoch", async () => {
    const store = memoryStatusStore(null);
    const run = vi.fn(route({ status: statusOut }));
    const [a, b] = await Promise.all([
      refreshStatus(store, run, 1),
      refreshStatus(store, run, 2),
    ]);
    expect(a).toBe(b);
    expect(run).toHaveBeenCalledTimes(1);
  });

  const out = (nami: boolean) =>
    `{"climate":null,"nami_home":${nami},"someone_home":true}`;
  const deferred = () => {
    let resolve!: (v: string) => void;
    const promise = new Promise<string>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("keeps the newer read when an older one lands last", async () => {
    const store = memoryStatusStore(null);
    const slow = deferred();
    const a = refreshStatus(store, () => slow.promise, 10);
    await namiPresence(false, async () => "", store, clock(11, 12));
    const b = await refreshStatus(store, async () => out(false), 13);
    slow.resolve(out(true));
    const aResult = await a;
    expect(b?.status.namiHome).toBe(false);
    expect(aResult).toBe(await store.read());
    expect(aResult?.fetchedAt).toBe(13);
  });

  it("discards a read in flight while a write runs, resolving before or after it settles", async () => {
    const store = memoryStatusStore(null);
    const set = deferred();
    const setting = namiPresence(true, () => set.promise, store, clock(20, 25));

    const early = refreshStatus(store, async () => out(false), 21);
    expect(await early).toBeNull();
    expect(store.write).not.toHaveBeenCalled();

    const lateGate = deferred();
    const late = refreshStatus(store, () => lateGate.promise, 22);
    set.resolve("");
    await setting;
    lateGate.resolve(out(false));
    const lateResult = await late;
    expect(lateResult?.status.namiHome).toBe(true);
    expect(lateResult?.fetchedAt).toBe(25);
  });

  it("discards reads during either of two overlapping writes (double tap)", async () => {
    const store = memoryStatusStore(null);
    const first = deferred();
    const second = deferred();
    const a = namiPresence(true, () => first.promise, store, clock(30, 35));
    const b = namiPresence(false, () => second.promise, store, clock(31, 36));
    first.resolve("");
    await a;
    // the first write settled, the second still runs
    expect(await refreshStatus(store, async () => out(true), 40)).toMatchObject(
      { status: { namiHome: true } },
    );
    expect((await store.read())?.status.namiHome).toBe(true);
    second.resolve("");
    await b;
    expect((await store.read())?.status.namiHome).toBe(false);
    expect(await store.readMarker()).toEqual({ startedAt: 31, settledAt: 36 });
  });

  it("discards an in-flight read when another runtime's marker says a write ran", async () => {
    const store = memoryStatusStore({
      status: { climate: null, namiHome: false, someoneHome: true },
      fetchedAt: 1,
      climateAt: 1,
    });
    const slow = deferred();
    const read = refreshStatus(store, () => slow.promise, 50);
    // another command started and settled a write after this read began
    await store.writeMarker({ startedAt: 51, settledAt: 52 });
    slow.resolve(out(true));
    expect((await read)?.status.namiHome).toBe(false);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("discards a read while another runtime's write is unsettled", async () => {
    const store = memoryStatusStore(null, { startedAt: 40, settledAt: null });
    expect(await refreshStatus(store, async () => out(true), 60)).toBeNull();
    expect(store.write).not.toHaveBeenCalled();
  });

  it("treats an unsettled marker as settled after twice the timeout", async () => {
    const bound = 40_000;
    const stale = memoryStatusStore(null, { startedAt: 100, settledAt: null });
    expect(
      await refreshStatus(stale, async () => out(true), 100 + bound),
    ).toBeNull();
    const applied = await refreshStatus(
      stale,
      async () => out(true),
      100 + bound + 1,
    );
    expect(applied?.status.namiHome).toBe(true);
  });

  it("applies a read that starts after the last write settled", async () => {
    const store = memoryStatusStore(null, { startedAt: 70, settledAt: 71 });
    const got = await refreshStatus(store, async () => out(true), 72);
    expect(got?.status.namiHome).toBe(true);
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it("writes the set value to the cache immediately", async () => {
    const store = memoryStatusStore({
      status: { climate: null, namiHome: true, someoneHome: true },
      fetchedAt: 1,
      climateAt: 1,
    });
    const run = vi.fn(async () => "");
    const written = await namiPresence(false, run, store, () => 5);
    expect(run).toHaveBeenCalledWith([
      "set",
      "Nami zu Hause",
      "power",
      "false",
    ]);
    expect(written).toEqual({
      status: { climate: null, namiHome: false, someoneHome: true },
      fetchedAt: 5,
      climateAt: 1,
    });
    expect(await store.read()).toEqual(written);
  });

  it("leaves the cache untouched when the set fails, and still voids in-flight reads", async () => {
    const initial = {
      status: { climate: null, namiHome: true, someoneHome: true },
      fetchedAt: 1,
      climateAt: 1,
    };
    const store = memoryStatusStore(initial);
    const slow = deferred();
    const before = refreshStatus(store, () => slow.promise, 30);
    await expect(
      namiPresence(
        false,
        async () => {
          throw new Error("timed out");
        },
        store,
        clock(31, 32),
      ),
    ).rejects.toThrow("timed out");
    slow.resolve(out(false));
    expect(await before).toBe(initial);
    expect(store.write).not.toHaveBeenCalled();
    expect(await store.read()).toBe(initial);
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
      climateAt: 1,
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

  it("keeps cached scenes when only the scenes call fails", async () => {
    const stale: HomeCache = { scenes, doctor: null, fetchedAt: 0 };
    const got = await loadMenuBar(
      memoryStatusStore(null),
      memoryStore(stale),
      route({ status: statusOut, scenes: new Error("ssh") }),
      7 * 60 * 60_000,
    );
    expect(got.error).toBeNull();
    expect(got.scenes).toBe(scenes);
  });
});
