/*
 * Helpers for clearing heartbeat/uptime statistics.
 *
 * Besides deleting the rows in the database, the in-memory
 * UptimeCalculator of the affected monitor(s) must be reset too,
 * otherwise old counts keep participating in uptime and average
 * response time calculations until the server is restarted.
 */
const { R } = require("redbean-node");
const { UptimeCalculator } = require("./uptime-calculator");

/**
 * Clear all heartbeats and uptime statistics of a single monitor.
 * The monitor itself is not modified.
 * @param {number} monitorID ID of the monitor whose data should be cleared
 * @returns {Promise<void>}
 */
async function clearMonitorData(monitorID) {
    await R.exec("DELETE FROM heartbeat WHERE monitor_id = ?", [
        monitorID,
    ]);

    await R.exec("DELETE FROM stat_daily WHERE monitor_id = ?", [
        monitorID,
    ]);

    await R.exec("DELETE FROM stat_hourly WHERE monitor_id = ?", [
        monitorID,
    ]);

    await R.exec("DELETE FROM stat_minutely WHERE monitor_id = ?", [
        monitorID,
    ]);

    // Drop the in-memory calculator; it is re-created from the now empty
    // stat tables on the next heartbeat, so the uptime starts from zero.
    await UptimeCalculator.remove(monitorID);
}

/**
 * Clear all heartbeats and uptime statistics of all monitors.
 * Monitor settings are not modified.
 * @returns {Promise<void>}
 */
async function clearAllMonitorData() {
    await R.exec("DELETE FROM heartbeat");
    await R.exec("DELETE FROM stat_daily");
    await R.exec("DELETE FROM stat_hourly");
    await R.exec("DELETE FROM stat_minutely");

    // Reset all in-memory calculators, so no old counts survive.
    for (let monitorID in UptimeCalculator.list) {
        await UptimeCalculator.remove(monitorID);
    }
}

module.exports = {
    clearMonitorData,
    clearAllMonitorData,
};
