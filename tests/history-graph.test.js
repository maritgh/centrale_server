const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = filename => fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');

function setupGraph(initialReadings = []) {
    const elements = {};
    const documentListeners = {};
    const timers = new Map();
    const calls = [];
    const chartInstances = [];
    let intervalId = 0;
    let readings = initialReadings;
    function node(value = '') {
        return {
            value, textContent: '', children: [], listeners: {},
            addEventListener(name, fn) { this.listeners[name] = fn; },
            appendChild(child) { this.children.push(child); },
            replaceChildren() { this.children = []; },
            get options() { return this.children; },
            getContext() { return {}; },
        };
    }
    elements.graphMetric = node('temperature');
    elements.graphPeriod = node('7d');
    elements.graphStatus = node();
    elements.historyGraph = node();
    class FakeChart {
        constructor(ctx, options) {
            this.options = options;
            this.data = options.data;
            this.destroyed = false;
            this.updates = [];
            chartInstances.push(this);
        }
        destroy() { this.destroyed = true; }
        update(mode) { this.updates.push(mode); }
    }
    const window = {};
    const document = {
        visibilityState: 'visible',
        getElementById(name) { return elements[name]; },
        createElement() { return node(); },
        addEventListener(name, fn) { documentListeners[name] = fn; },
    };
    const context = vm.createContext({
        document, window, Chart: FakeChart, Intl, Date, Number, URLSearchParams,
        setInterval(fn, ms) { const id = ++intervalId; timers.set(id, { fn, ms }); return id; },
        clearInterval(id) { timers.delete(id); },
        fetch: async (url, options) => {
            calls.push({ url, options });
            return { ok: true, json: async () => ({ readings }) };
        },
    });
    vm.runInContext(source('public/js/history-graph.js'), context);
    return { elements, document, window, documentListeners, timers, calls, chartInstances,
        setReadings(next) { readings = next; },
        async tick() { for (const timer of timers.values()) await timer.fn(); },
    };
}

test('grafiek haalt meetwaarden chronologisch op, inclusief eigen grootheden, met meer tijdlabels', async () => {
    const graph = setupGraph([
        { received_at: '2026-10-27T15:00:00Z', value: 21, samples: 12 },
        { received_at: '2026-10-27T08:00:00Z', value: 17, samples: 12 },
    ]);
    const { window, elements, calls, chartInstances } = graph;
    window.historyGraph.setMetrics([{ slug: 'luchtdruk', name: 'Luchtdruk', unit: 'hPa' }]);
    assert.ok(elements.graphMetric.children.some(option => option.value === 'custom/luchtdruk'));
    await window.historyGraph.refresh();
    assert.equal(chartInstances.length, 1);
    assert.deepEqual([...chartInstances[0].data.datasets[0].data.map(point => point.y)], [17, 21]);
    assert.match(calls[0].url, /history\/graph\?metric=temperature&period=7d/);
    assert.equal(chartInstances[0].data.datasets[0].borderColor, '#1f2933');
    assert.equal(chartInstances[0].data.datasets[0].fill, false);
    assert.equal(chartInstances[0].options.options.scales.x.ticks.maxTicksLimit, 10);
    assert.equal(chartInstances[0].options.options.scales.x.ticks.autoSkip, true);
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.match(elements.graphStatus.textContent, /24 metingen weergegeven als 2 gemiddelden per 30 minuten/);
    assert.match(elements.graphStatus.textContent, /elke 30 seconden/);
    assert.equal(chartInstances[0].options.options.plugins.tooltip.callbacks.afterLabel({raw:{samples:12}}), 'Gemiddelde van 12 metingen');

    elements.graphPeriod.value = 'yesterday';
    await elements.graphPeriod.listeners.change();
    assert.match(calls[1].url, /period=yesterday/);
    assert.equal(chartInstances[0].destroyed, true);
    window.historyGraph.clear();
    assert.equal(chartInstances[1].destroyed, true);
    assert.equal(elements.graphStatus.textContent, '');
});

test('grafiek ververst elke 30 seconden zonder knipperen en stopt buiten de ingelogde sessie', async () => {
    const initial = [{ received_at: '2026-10-28T11:00:00Z', value: 21, samples: 1 }];
    const graph = setupGraph(initial);
    const { window, elements, document, documentListeners, timers, calls, chartInstances } = graph;
    await window.historyGraph.refresh();
    window.historyGraph.startAutoRefresh();
    window.historyGraph.startAutoRefresh(); // Een tweede login mag geen extra timer starten.
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].ms, 30000);

    await graph.tick();
    assert.equal(calls.length, 2);
    assert.equal(chartInstances.length, 1);
    assert.equal(chartInstances[0].updates.length, 0); // Exact dezelfde data, geen nieuwe tekening.

    graph.setReadings([...initial, { received_at: '2026-10-28T11:05:00Z', value: 22, samples: 2 }]);
    await graph.tick();
    assert.equal(chartInstances.length, 1); // Dezelfde grafiek blijft zichtbaar.
    assert.deepEqual(chartInstances[0].updates, ['none']);
    assert.equal(chartInstances[0].destroyed, false);
    assert.equal(elements.graphStatus.textContent.includes('Grafiek laden'), false);
    assert.match(elements.graphStatus.textContent, /3 metingen/);

    document.visibilityState = 'hidden';
    await graph.tick();
    assert.equal(calls.length, 3); // Geen verzoek wanneer tabblad niet actief is.
    document.visibilityState = 'visible';
    await documentListeners.visibilitychange();
    assert.equal(calls.length, 4); // Direct bij terugkomen opnieuw ophalen.

    window.historyGraph.stopAutoRefresh();
    assert.equal(timers.size, 0);
    await graph.tick();
    assert.equal(calls.length, 4);
});

test('accountpagina start automatisch verversen na inloggen en stopt bij uitloggen', () => {
    const account = source('public/js/account.js');
    assert.match(account, /function showStation\(station\)\s*\{[\s\S]*?window\.historyGraph\?\.startAutoRefresh\(\)/);
    assert.match(account, /function showLoggedOut\(\)\s*\{[\s\S]*?window\.historyGraph\?\.stopAutoRefresh\(\)/);
});

test('grafiek-API valideert filters en beperkt data tot eigen station', async () => {
    const routes = {};
    const fakeRouter = { use() {}, get(route, handler) { routes[route] = handler; }, post() {}, patch() {}, delete() {} };
    const sandbox = {
        module: { exports: {} },
        require(name) {
            if (name === 'express') return { Router() { return fakeRouter; } };
            if (name === './station-id') return { createStationId: name => name };
            return require(name);
        },
        process, Buffer,
    };
    vm.runInNewContext(source('src/account.js'), sandbox);
    const queries = [];
    sandbox.module.exports.createAccountRouter({ pool: { async query(sql, args) {
        queries.push({ sql, args });
        return { rows: [{ value: 19, received_at: '2026-10-27T08:00:00Z' }] };
    } } });
    const handler = routes['/history/graph'];
    async function call(query) {
        let answer;
        const res = { status(code) { this.code = code; return this; }, json(data) { answer = { status: this.code || 200, data }; } };
        await handler({ query, station: { id: 'elisatest' } }, res, error => { throw error; });
        return answer;
    }
    assert.equal((await call({ metric: 'wrong' })).status, 400);
    assert.equal((await call({ period: 'lastYear' })).status, 400);
    assert.equal(queries.length, 0);
    assert.equal((await call({ metric: 'temperature', period: 'yesterday' })).status, 200);
    assert.equal(queries[0].args[0], 'elisatest');
    assert.equal(queries[0].args[1], 'yesterday');
    assert.equal(queries[0].args[2], 'temperature');
    assert.match(queries[0].sql, /ORDER BY 1 ASC/);
    assert.match(queries[0].sql, /h\.station_id = \$1/);
});
