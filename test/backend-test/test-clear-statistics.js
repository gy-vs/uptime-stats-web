process.env.TEST_BACKEND = "1";

const test = require("node:test");
const assert = require("node:assert");
const knex = require("knex");
const { R } = require("redbean-node");
const { UptimeCalculator } = require("../../server/uptime-calculator");
const dayjs = require("dayjs");
const { UP, DOWN } = require("../../src/util");

dayjs.extend(require("dayjs/plugin/utc"));

/**
 * Set up an in-memory SQLite database with the uptime aggregate tables.
 * @returns {Promise<void>}
 */
async function connectTestDatabase() {
    const Dialect = require("knex/lib/dialects/sqlite3/index.js");
    Dialect.prototype._driver = () => require("@louislam/sqlite3");

    const knexInstance = knex({
        client: Dialect,
        connection: {
            filename: ":memory:",
        },
        useNullAsDefault: true,
        log: {
            warn() { },
            error() { },
            deprecate() { },
            debug() { },
        },
    });

    R.setup(knexInstance);

    await R.exec("PRAGMA foreign_keys = ON");

    await R.knex.schema.createTable("stat_minutely", (table) => {
        table.increments("id");
        table.integer("monitor_id").notNullable();
        table.integer("timestamp").notNullable();
        table.float("ping").defaultTo(0);
        table.float("ping_min").defaultTo(0);
        table.float("ping_max").defaultTo(0);
        table.smallint("up").notNullable();
        table.smallint("down").notNullable();
        table.text("extras").defaultTo(null);
    });

    await R.knex.schema.createTable("stat_hourly", (table) => {
        table.increments("id");
        table.integer("monitor_id").notNullable();
        table.integer("timestamp").notNullable();
        table.float("ping").defaultTo(0);
        table.float("ping_min").defaultTo(0);
        table.float("ping_max").defaultTo(0);
        table.smallint("up").notNullable();
        table.smallint("down").notNullable();
        table.text("extras").defaultTo(null);
    });

    await R.knex.schema.createTable("stat_daily", (table) => {
        table.increments("id");
        table.integer("monitor_id").notNullable();
        table.integer("timestamp").notNullable();
        table.float("ping").defaultTo(0);
        table.float("ping_min").defaultTo(0);
        table.float("ping_max").defaultTo(0);
        table.smallint("up").notNullable();
        table.smallint("down").notNullable();
        table.text("extras").defaultTo(null);
    });
}

/**
 * Insert one aggregate row into every stat table.
 * @param {number} monitorID ID of the monitor
 * @param {dayjs.Dayjs} date Date used for the truncated timestamps
 * @param {number} up Number of up beats
 * @param {number} down Number of down beats
 * @param {number} ping Average ping
 * @returns {Promise<void>}
 */
async function insertStats(monitorID, date, up, down, ping) {
    await R.exec(
        "INSERT INTO stat_minutely (monitor_id, timestamp, ping, ping_min, ping_max, up, down) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [ monitorID, date.startOf("minute").unix(), ping, ping, ping, up, down ]
    );
    await R.exec(
        "INSERT INTO stat_hourly (monitor_id, timestamp, ping, ping_min, ping_max, up, down) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [ monitorID, date.startOf("hour").unix(), ping, ping, ping, up, down ]
    );
    await R.exec(
        "INSERT INTO stat_daily (monitor_id, timestamp, ping, ping_min, ping_max, up, down) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [ monitorID, date.utc().startOf("day").unix(), ping, ping, ping, up, down ]
    );
}

test.beforeEach(async () => {
    await connectTestDatabase();
    UptimeCalculator.currentDate = dayjs.utc("2023-08-12 20:46:59");
});

test.afterEach(async () => {
    for (let monitorID of Object.keys(UptimeCalculator.list)) {
        await UptimeCalculator.remove(monitorID);
    }
    UptimeCalculator.currentDate = null;
    await R.close();
});

test("Uptime is recalculated after clearing the statistics of one monitor", async () => {
    const monitorID = 1;
    const otherMonitorID = 2;

    // Simulate the 3 down (ping 900) + 1 up (ping 100) heartbeats.
    // In test mode update() does not write to the database, so the aggregate
    // rows are inserted directly like the running server would have done.
    let calculator = await UptimeCalculator.getUptimeCalculator(monitorID);
    await calculator.update(DOWN, 900);
    await calculator.update(DOWN, 900);
    await calculator.update(DOWN, 900);
    await calculator.update(UP, 100);
    await insertStats(monitorID, UptimeCalculator.currentDate, 1, 3, 100);

    await insertStats(otherMonitorID, UptimeCalculator.currentDate, 1, 1, 200);

    // The freshly initialized calculator loads the stored aggregates.
    await UptimeCalculator.remove(monitorID);
    calculator = await UptimeCalculator.getUptimeCalculator(monitorID);

    assert.strictEqual(calculator.get24Hour().uptime, 0.25);
    assert.strictEqual(calculator.get30Day().uptime, 0.25);
    assert.strictEqual(calculator.get1Year().uptime, 0.25);
    assert.strictEqual(calculator.get24Hour().avgPing, 100);

    // This is what the "clear heartbeats" socket handler does.
    await UptimeCalculator.clearData(monitorID);
    await UptimeCalculator.remove(monitorID);

    // No history left: everything must start from zero again.
    calculator = await UptimeCalculator.getUptimeCalculator(monitorID);
    assert.strictEqual(calculator.get24Hour().uptime, 0);
    assert.strictEqual(calculator.get30Day().uptime, 0);
    assert.strictEqual(calculator.get1Year().uptime, 0);
    assert.strictEqual(calculator.get24Hour().avgPing, null);

    let statRows = await R.getAll("SELECT * FROM stat_minutely WHERE monitor_id = ?", [ monitorID ]);
    assert.strictEqual(statRows.length, 0);
    statRows = await R.getAll("SELECT * FROM stat_hourly WHERE monitor_id = ?", [ monitorID ]);
    assert.strictEqual(statRows.length, 0);
    statRows = await R.getAll("SELECT * FROM stat_daily WHERE monitor_id = ?", [ monitorID ]);
    assert.strictEqual(statRows.length, 0);

    // The first heartbeat after clearing is the only one that counts.
    await calculator.update(UP, 50);
    assert.strictEqual(calculator.get24Hour().uptime, 1);
    assert.strictEqual(calculator.get30Day().uptime, 1);
    assert.strictEqual(calculator.get1Year().uptime, 1);
    assert.strictEqual(calculator.get24Hour().avgPing, 50);

    // Other monitors must be untouched.
    let otherRows = await R.getAll("SELECT * FROM stat_minutely WHERE monitor_id = ?", [ otherMonitorID ]);
    assert.strictEqual(otherRows.length, 1);
    let otherCalculator = await UptimeCalculator.getUptimeCalculator(otherMonitorID);
    assert.strictEqual(otherCalculator.get24Hour().uptime, 0.5);
    assert.strictEqual(otherCalculator.get24Hour().avgPing, 200);
});

test("Uptime is recalculated after clearing all statistics", async () => {
    const monitorID = 3;

    // 2 down + 1 up = 33.33% uptime
    let calculator = await UptimeCalculator.getUptimeCalculator(monitorID);
    await calculator.update(DOWN, 0);
    await calculator.update(DOWN, 0);
    await calculator.update(UP, 100);
    await insertStats(monitorID, UptimeCalculator.currentDate, 1, 2, 100);

    await UptimeCalculator.remove(monitorID);
    calculator = await UptimeCalculator.getUptimeCalculator(monitorID);
    assert.strictEqual(Number((calculator.get24Hour().uptime * 100).toFixed(2)), 33.33);

    // This is what the "clear all statistics" socket handler does.
    await UptimeCalculator.clearAllData();
    for (let id of Object.keys(UptimeCalculator.list)) {
        await UptimeCalculator.remove(id);
    }

    assert.strictEqual((await R.getAll("SELECT * FROM stat_daily")).length, 0);
    assert.strictEqual((await R.getAll("SELECT * FROM stat_hourly")).length, 0);
    assert.strictEqual((await R.getAll("SELECT * FROM stat_minutely")).length, 0);

    calculator = await UptimeCalculator.getUptimeCalculator(monitorID);
    assert.strictEqual(calculator.get24Hour().uptime, 0);
    assert.strictEqual(calculator.get30Day().uptime, 0);
    assert.strictEqual(calculator.get1Year().uptime, 0);
    assert.strictEqual(calculator.get24Hour().avgPing, null);

    // A single new up heartbeat must result in 100% instead of 50%.
    await calculator.update(UP, 75);
    assert.strictEqual(calculator.get24Hour().uptime, 1);
    assert.strictEqual(calculator.get30Day().uptime, 1);
    assert.strictEqual(calculator.get1Year().uptime, 1);
    assert.strictEqual(calculator.get24Hour().avgPing, 75);
});
