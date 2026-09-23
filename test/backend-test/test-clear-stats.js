const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");

dayjs.extend(require("dayjs/plugin/utc"));

const { R } = require("redbean-node");
const Database = require("../../server/database");
const { UptimeCalculator } = require("../../server/uptime-calculator");
const { clearMonitorData, clearAllMonitorData } = require("../../server/stats");
const { UP, DOWN } = require("../../src/util");

/**
 * Set up a fresh temporary SQLite database with the full migration chain.
 * @returns {Promise<void>}
 */
async function connectTestDatabase() {
    let testDataDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "kuma-clear-stats-"));
    Database.initDataDir({ "data-dir": path.join(testDataDir, "data") + path.sep });
    Database.writeDBConfig({ type: "sqlite" });

    await Database.connect(true, true, true);
    await Database.patch();
}

/**
 * Insert a monitor row directly into the database.
 * @param {number} id Monitor ID
 * @returns {Promise<void>}
 */
async function insertMonitor(id) {
    await R.exec(
        "INSERT INTO monitor (id, name, active, user_id, type, interval) VALUES (?, ?, 1, NULL, ?, ?)",
        [ id, `Test Monitor ${id}`, "push", 3600 ]
    );
}

/**
 * Insert one aggregated stat row.
 * @param {"stat_daily"|"stat_hourly"|"stat_minutely"} table Stat table
 * @param {number} monitorID Monitor ID
 * @param {number} timestamp Period key (unix seconds)
 * @param {number} up Up beat count
 * @param {number} down Down beat count
 * @param {number} ping Average ping
 * @returns {Promise<void>}
 */
async function insertStat(table, monitorID, timestamp, up, down, ping) {
    await R.exec(
        `INSERT INTO ${table} (monitor_id, timestamp, up, down, ping, ping_min, ping_max)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ monitorID, timestamp, up, down, ping, ping, ping ]
    );
}

/**
 * Build stat rows for a monitor: 3 down beats then 1 up beat (ping 100),
 * so every period reports 25% uptime and 100ms average ping.
 * @param {number} monitorID Monitor ID
 * @returns {Promise<void>}
 */
async function insertThreeDownOneUpStats(monitorID) {
    let now = dayjs.utc();

    await insertStat("stat_minutely", monitorID, now.startOf("minute").unix(), 1, 3, 100);
    await insertStat("stat_hourly", monitorID, now.startOf("hour").unix(), 1, 3, 100);
    await insertStat("stat_daily", monitorID, now.startOf("day").unix(), 1, 3, 100);

    // Heartbeats are deleted too
    for (let i = 0; i < 3; i++) {
        await R.exec(
            "INSERT INTO heartbeat (monitor_id, status, ping, time, important, duration, down_count) VALUES (?, ?, ?, ?, ?, 0, 0)",
            [ monitorID, DOWN, 900, now.subtract(4 - i, "hour").format("YYYY-MM-DD HH:mm:ss"), i === 0 ? 1 : 0 ]
        );
    }
    await R.exec(
        "INSERT INTO heartbeat (monitor_id, status, ping, time, important, duration, down_count) VALUES (?, ?, ?, ?, 1, 0, 0)",
        [ monitorID, UP, 100, now.format("YYYY-MM-DD HH:mm:ss") ]
    );
}

/**
 * Assert that the calculator reports 25% uptime and 100ms average ping.
 * @param {UptimeCalculator} calculator Calculator to check
 * @returns {void}
 */
function assertOldStats(calculator) {
    assert.strictEqual(calculator.get24Hour().uptime, 0.25);
    assert.strictEqual(calculator.get24Hour().avgPing, 100);
    assert.strictEqual(calculator.get30Day().uptime, 0.25);
    assert.strictEqual(calculator.get1Year().uptime, 0.25);
}

test.before(async () => {
    await connectTestDatabase();
});

test.after(async () => {
    await Database.close();

    // The SQLite connection pool keeps the process alive otherwise
    process.exit(0);
});

test("clearing one monitor resets its stats, keeps other monitors untouched", async (t) => {
    UptimeCalculator.list = {};

    await R.exec("DELETE FROM heartbeat");
    await R.exec("DELETE FROM stat_daily");
    await R.exec("DELETE FROM stat_hourly");
    await R.exec("DELETE FROM stat_minutely");

    await insertMonitor(1);
    await insertMonitor(2);

    await insertThreeDownOneUpStats(1);
    await insertThreeDownOneUpStats(2);

    // Sanity check: both calculators report the old 25% / 100ms data
    let calc1 = await UptimeCalculator.getUptimeCalculator(1);
    let calc2 = await UptimeCalculator.getUptimeCalculator(2);
    assertOldStats(calc1);
    assertOldStats(calc2);

    await clearMonitorData(1);

    await t.test("heartbeats and stat rows of the monitor are deleted", async () => {
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM heartbeat WHERE monitor_id = 1"), 0);
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM stat_daily WHERE monitor_id = 1"), 0);
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM stat_hourly WHERE monitor_id = 1"), 0);
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM stat_minutely WHERE monitor_id = 1"), 0);
    });

    await t.test("uptime is calculated from zero after clearing", async () => {
        // The old in-memory calculator must be gone
        assert.strictEqual(UptimeCalculator.list[1], undefined);

        let newCalc = await UptimeCalculator.getUptimeCalculator(1);
        assert.strictEqual(newCalc.get24Hour().uptime, 0);
        assert.strictEqual(newCalc.get24Hour().avgPing, null);
        assert.strictEqual(newCalc.get30Day().uptime, 0);
        assert.strictEqual(newCalc.get1Year().uptime, 0);

        // One new up beat (ping 50): everything must start from zero,
        // so uptime is 100% and the average ping is 50ms, not 40%/75ms.
        await newCalc.update(UP, 50);
        assert.strictEqual(newCalc.get24Hour().uptime, 1);
        assert.strictEqual(newCalc.get24Hour().avgPing, 50);
        assert.strictEqual(newCalc.get30Day().uptime, 1);
        assert.strictEqual(newCalc.get1Year().uptime, 1);
    });

    await t.test("other monitors are untouched", async () => {
        assertOldStats(calc2);
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM heartbeat WHERE monitor_id = 2"), 4);
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM stat_daily WHERE monitor_id = 2"), 1);
    });

    await t.test("monitor settings are not modified", async () => {
        let monitor = await R.getRow("SELECT name, type, interval, active FROM monitor WHERE id = 1");
        assert.strictEqual(monitor.name, "Test Monitor 1");
        assert.strictEqual(monitor.type, "push");
        assert.strictEqual(monitor.interval, 3600);
        assert.strictEqual(monitor.active, 1);
    });
});

test("clearing all statistics resets every monitor", async (t) => {
    UptimeCalculator.list = {};

    await R.exec("DELETE FROM heartbeat");
    await R.exec("DELETE FROM stat_daily");
    await R.exec("DELETE FROM stat_hourly");
    await R.exec("DELETE FROM stat_minutely");

    await insertThreeDownOneUpStats(1);
    await insertThreeDownOneUpStats(2);

    assertOldStats(await UptimeCalculator.getUptimeCalculator(1));
    assertOldStats(await UptimeCalculator.getUptimeCalculator(2));

    await clearAllMonitorData();

    await t.test("all heartbeats and stat rows are deleted", async () => {
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM heartbeat"), 0);
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM stat_daily"), 0);
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM stat_hourly"), 0);
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM stat_minutely"), 0);
    });

    await t.test("all in-memory calculators are reset", async () => {
        assert.deepStrictEqual(UptimeCalculator.list, {});

        for (let monitorID of [ 1, 2 ]) {
            let calc = await UptimeCalculator.getUptimeCalculator(monitorID);
            assert.strictEqual(calc.get24Hour().uptime, 0);
            assert.strictEqual(calc.get24Hour().avgPing, null);

            await calc.update(UP, 50);
            assert.strictEqual(calc.get24Hour().uptime, 1);
            assert.strictEqual(calc.get24Hour().avgPing, 50);
            assert.strictEqual(calc.get30Day().uptime, 1);
            assert.strictEqual(calc.get1Year().uptime, 1);
        }
    });

    await t.test("monitors themselves still exist", async () => {
        assert.strictEqual(await R.getCell("SELECT COUNT(*) FROM monitor"), 2);
    });
});
