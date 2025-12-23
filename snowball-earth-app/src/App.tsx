
import { useEffect, useRef, useState, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, LineChart, Line } from 'recharts';
import { Play, Pause, RotateCcw, Thermometer, Sun, CloudFog, AlertTriangle } from 'lucide-react';
import { EBM, DEFAULT_PARAMS } from './engine/ebm';
import { InfoTooltip } from './components/InfoTooltip';
import './index.css';

function App() {
  // Simulation State
  const ebmRef = useRef<EBM>(new EBM(90, DEFAULT_PARAMS));
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);
  const [generation, setGeneration] = useState(0); // To trigger re-renders
  const generationRef = useRef(0); // Track generation for limit check
  const equilibriumStartTimeRef = useRef<number | null>(null);
  const MAX_GENERATIONS = 2000;

  // Object Pool for Chart Data (Persistent memory)
  interface ChartData {
    lat: number;
    temp: number;
    albedo: number;
    asr: number;
    olr: number;
    freezing: number;
    transport: number;
  }


  const [data, setData] = useState<ChartData[]>([]);

  // Parameter State
  const [solarMultiplier, setSolarMultiplier] = useState(1.0);
  const [co2Multiplier, setCo2Multiplier] = useState(1.0); // Modifies A (greenhouse) inversely? Or B?
  // Simply: OLR = (A - raw_forcing) + B*T. 
  // Increasing CO2 reduces OLR for same T. So it reduces A.
  // Let's define: A_eff = A - forcing.
  // We'll trust the user interface "CO2" means warming.

  // Sync chart data - create NEW objects (immutable)
  const syncChartData = useCallback(() => {
    const ebm = ebmRef.current;
    const newData: ChartData[] = [];

    // South Pole
    newData.push({
      lat: -90,
      temp: ebm.T[0],
      albedo: ebm.albedo[0],
      asr: ebm.ASR[0],
      olr: ebm.OLR[0],
      freezing: ebm.params.iceThreshold,
      transport: ebm.transport[0]
    });

    // Grid
    for (let i = 0; i < ebm.size; i++) {
      newData.push({
        lat: ebm.lat[i],
        temp: ebm.T[i],
        albedo: ebm.albedo[i],
        asr: ebm.ASR[i],
        olr: ebm.OLR[i],
        freezing: ebm.params.iceThreshold,
        transport: ebm.transport[i]
      });
    }

    // North Pole
    newData.push({
      lat: 90,
      temp: ebm.T[ebm.size - 1],
      albedo: ebm.albedo[ebm.size - 1],
      asr: ebm.ASR[ebm.size - 1],
      olr: ebm.OLR[ebm.size - 1],
      freezing: ebm.params.iceThreshold,
      transport: ebm.transport[ebm.size - 1]
    });

    setData(newData);
  }, []);

  const handleReset = useCallback(() => {
    ebmRef.current = new EBM(90, DEFAULT_PARAMS);
    setSolarMultiplier(1.0);
    setCo2Multiplier(1.0);
    setGeneration(0);
    generationRef.current = 0;
    setIsRunning(false);
    isRunningRef.current = false;
    equilibriumStartTimeRef.current = null;
  }, []);

  // Loop
  useEffect(() => {
    let animationFrameId: number;
    let lastRenderTime = 0;

    const loop = (time: number) => {
      if (isRunning) {
        // Check generation limit using ref (not stale closure)
        if (generationRef.current >= MAX_GENERATIONS) {
          console.warn('Max generations reached. Auto-resetting...');
          handleReset();
          return;
        }

        // Run physics steps (reduced from 5 to 2-3 for slower, more perceptible changes)
        for (let i = 0; i < 2; i++) {
          ebmRef.current.step(0.05);
        }

        // Check if in equilibrium
        const globalNetFlux = ebmRef.current.getGlobalMeanNetFlux();
        const isInEquilibrium = Math.abs(globalNetFlux) < 1;

        if (isInEquilibrium) {
          if (equilibriumStartTimeRef.current === null) {
            equilibriumStartTimeRef.current = time;
          } else if (time - equilibriumStartTimeRef.current > 1000) {
            // Been in equilibrium for 1 second - auto-pause
            console.log('Equilibrium reached. Auto-pausing...');
            setIsRunning(false);
            equilibriumStartTimeRef.current = null;
            return;
          }
        } else {
          equilibriumStartTimeRef.current = null;
        }

        // Throttle UI updates to ~15FPS (66ms)
        if (time - lastRenderTime > 66) {
          syncChartData();
          generationRef.current += 1;
          setGeneration(g => g + 1);
          lastRenderTime = time;
        }
        animationFrameId = requestAnimationFrame(loop);
      } else {
        animationFrameId = requestAnimationFrame(loop);
      }
    };
    animationFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isRunning]);

  // Sync Parameters
  useEffect(() => {
    const ebm = ebmRef.current;
    // S0
    ebm.params.S0 = DEFAULT_PARAMS.S0 * solarMultiplier;
    ebm.computeInsolation(); // Recompute only when S0 changes

    // CO2 Effect:
    // We model CO2 increase as a reduction in A (the constant term in OLR A+BT).
    // A reduction in A means less outgoing radiation -> warming.
    // Let's say 2x CO2 ~ 4 W/m2 forcing. 
    // This slider is abstract "Greenhouse Multiplier".
    // 1.0 = standard. 0.5 = less greenhouse (higher A). 1.5 = more greenhouse (lower A).
    // range 0.5 to 1.5?
    // Let's map slider 0.5-2.0 to a forcing term.
    // New A = DefaultA * (1 / multiplier) ? Or A - (multiplier-1)*Constant?
    // Let's try: A_new = A_default - (co2Multiplier - 1) * 20;
    // If mult=1, A=A. If mult=2 (high CO2), A = A - 20 (warming).

    ebm.params.A = DEFAULT_PARAMS.A - (co2Multiplier - 1) * 30;

    ebm.updateDiagnostics();
    // When paused, we still need to update certain diagnostics and REFRESH THE CURVES
    if (!isRunningRef.current) {
      setGeneration(g => g + 1);
      syncChartData();
    }
    // Reset equilibrium timer when parameters change
    equilibriumStartTimeRef.current = null;

    // Auto-resume when sliders change (but not on initial load)
    if (!isRunningRef.current && generationRef.current > 0) {
      setIsRunning(true);
      isRunningRef.current = true;
    }
  }, [solarMultiplier, co2Multiplier, syncChartData]);

  // Keep ref synchronized with state
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  // Initial Data Sync (to ensure curves appear on load)
  useEffect(() => {
    syncChartData();
  }, [syncChartData]);



  // Prepare Data for Charts
  // Data handling moved to render loop for performance


  const globalTemp = ebmRef.current.getGlobalMeanTemp();
  const getClimateState = (temp: number) => {
    if (temp < -20) return { label: 'SNOWBALL', color: '#a5f3fc' };
    if (temp < 10) return { label: 'GLACIAL', color: '#94a3b8' };
    if (temp < 25) return { label: 'HABITABLE', color: '#86efac' };
    return { label: 'HOTHOUSE', color: '#fca5a5' };
  };
  const currentClimateState = getClimateState(globalTemp);

  const globalNetFlux = ebmRef.current.getGlobalMeanNetFlux();
  const isOutOfEquilibrium = Math.abs(globalNetFlux) > 1; // Threshold for "out of equilibrium"

  const latTicks = [-90, -60, -30, 0, 30, 60, 90];
  const formatNumber = (val: number) => val.toFixed(2);

  return (
    <div className="simulation-container" style={{ height: '100vh', padding: '20px', display: 'flex', gap: '20px' }}>

      {/* Sidebar Controls */}
      <div className="sidebar panel" style={{ width: '300px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <h1 style={{ background: 'linear-gradient(to right, #06b6d4, #3b82f6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontSize: '1.5rem' }}>
          Snowball Earth
        </h1>

        <div className="status-card" style={{ background: 'rgba(0,0,0,0.2)', padding: '15px', borderRadius: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '5px' }}>
            <Thermometer size={20} color={currentClimateState.color} />
            <span style={{ fontSize: '1.2em', fontWeight: 'bold' }}>{globalTemp.toFixed(1)}°C</span>
          </div>
          <div style={{ fontSize: '0.9em', color: '#94a3b8' }}>Global Mean Temperature</div>

          <div style={{ marginTop: '10px', fontWeight: 'bold', color: currentClimateState.color }}>
            {currentClimateState.label}
          </div>
          <div style={{ marginTop: '10px', height: '20px', display: 'flex', alignItems: 'center', gap: '5px', color: '#facc15', fontSize: '0.9em', visibility: isOutOfEquilibrium ? 'visible' : 'hidden' }}>
            <AlertTriangle size={16} />
            <span>Out of Equilibrium ({globalNetFlux.toFixed(1)} W/m²)</span>
          </div>

          {/* Debug Overlay */}
          <div style={{ marginTop: '15px', padding: '10px', background: '#00000040', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7em', color: '#64748b' }}>
            <div>Gen: {generation}</div>
            <div>S0 Mult: {solarMultiplier.toFixed(2)}</div>
            <div>CO2 Mult: {co2Multiplier.toFixed(2)}</div>
            <div>NetFlux: {globalNetFlux.toFixed(2)}</div>
          </div>
        </div>

        {/* Controls */}
        <div className="controls">

          <div className="slider-container">
            <div className="slider-label">
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><Sun size={16} /> Solar Strength ({Math.round(solarMultiplier * 100)}%)</span>
            </div>
            <input
              type="range"
              min="0.7"
              max="1.3"
              step="0.01"
              value={solarMultiplier}
              onChange={(e) => {
                setSolarMultiplier(parseFloat(e.target.value));
                // Force generation update immediately for responsiveness if paused
                if (!isRunning) setGeneration(g => g + 1);
              }}
            />
          </div>

          <div className="slider-container">
            <div className="slider-label">
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><CloudFog size={16} /> Greenhouse Gas</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.01"
              value={co2Multiplier}
              onChange={(e) => {
                setCo2Multiplier(parseFloat(e.target.value));
                if (!isRunning) setGeneration(g => g + 1);
              }}
            />
            <div style={{ fontSize: '0.8em', color: '#64748b' }}>
              {co2Multiplier > 1 ? `Warming (+${((co2Multiplier - 1) * 30).toFixed(0)} W/m²)` : `Cooling (${((co2Multiplier - 1) * 30).toFixed(0)} W/m²)`}
            </div>
          </div>

        </div>

        <div className="actions" style={{ marginTop: 'auto', display: 'flex', gap: '10px' }}>
          <button onClick={() => setIsRunning(!isRunning)} style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px' }}>
            {isRunning ? <><Pause size={18} /> Pause</> : <><Play size={18} /> Play</>}
          </button>
          <button onClick={handleReset} style={{ background: '#ef444420', color: '#fca5a5' }}>
            <RotateCcw size={18} />
          </button>
        </div>

        <div style={{ fontSize: '0.8em', color: '#64748b', marginTop: '10px' }}>
          Tip: Lower Solar Strength to ~90% to trigger runaway cooling. Then reset Solar Strength to 100% and observe hysteresis (it stays frozen).
        </div>
      </div>

      {/* Main Visuals */}
      <div className="main-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Top Plot: Temperature */}
        <div className="panel" style={{ flex: 1, minHeight: '300px', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>Surface Temperature</h3>
            <InfoTooltip text="Shows the surface temperature (°C) at each latitude. If the temperature drops below -10°C (dashed line), ice forms, increasing the albedo." />
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 20, right: 30, left: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="lat" label={{ value: 'Latitude', position: 'insideBottom', offset: -5 }} stroke="#94a3b8" ticks={latTicks} />
              <YAxis label={{ value: 'Temp (°C)', angle: -90, position: 'insideLeft' }} stroke="#94a3b8" domain={[-100, 60]} tickFormatter={formatNumber} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
                itemStyle={{ color: '#f1f5f9' }}
                labelFormatter={(v) => `Lat: ${Math.round(v)}°`}
                formatter={(val: any) => [val?.toFixed(2), '°C']}
                isAnimationActive={false}
              />
              <ReferenceLine y={-10} stroke="#a5f3fc" strokeDasharray="3 3" label="Ice Threshold" />
              <Line type="monotone" dataKey="temp" stroke="#06b6d4" strokeWidth={3} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Bottom Split: Energy & Albedo */}
        <div style={{ flex: 1, display: 'flex', gap: '20px', minHeight: '300px' }}>

          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>Energy Balance (W/m²)</h3>
              <InfoTooltip text="Comparison of Energy In vs Energy Out. 'Absorbed Solar' is energy from the Sun (minus reflection). 'Outgoing Longwave' is heat lost to space. 'Net Flux' (Green) is the difference; if non-zero, the temperature is changing." />
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="lat" stroke="#94a3b8" ticks={latTicks} type="number" domain={[-90, 90]} />
                <YAxis stroke="#94a3b8" domain={[-100, 450]} tickFormatter={formatNumber} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b' }}
                  itemStyle={{ color: '#fff' }}
                  formatter={(val: any) => [val?.toFixed(2), 'W/m²']}
                  labelFormatter={(v) => `Lat: ${Math.round(v)}°`}
                  isAnimationActive={false}
                />
                <Area type="monotone" dataKey="asr" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.3} name="Absorbed Solar" isAnimationActive={false} />
                <Line type="monotone" dataKey="olr" stroke="#ef4444" strokeWidth={2} dot={false} name="Outgoing Longwave" isAnimationActive={false} />
                <Line type="monotone" dataKey="netFlux" stroke="#84cc16" strokeWidth={2} dot={false} name="Net Flux (ASR-OLR)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>Albedo</h3>
              <InfoTooltip text="Albedo is the fraction of solar energy reflected back to space (0.0 to 1.0). High albedo (0.6, Ice) reflects cooling; low albedo (0.3, Ocean) absorbs heat." />
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="lat" stroke="#94a3b8" ticks={latTicks} type="number" domain={[-90, 90]} />
                <YAxis stroke="#94a3b8" domain={[0, 1]} tickFormatter={formatNumber} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b' }}
                  itemStyle={{ color: '#fff' }}
                  formatter={(val: any) => [val?.toFixed(2), '']}
                  labelFormatter={(v) => `Lat: ${Math.round(v)}°`}
                  isAnimationActive={false}
                />
                <Area type="step" dataKey="albedo" stroke="#e2e8f0" fill="#e2e8f0" fillOpacity={0.5} name="Albedo" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

        </div>

      </div>
    </div>
  );
}

export default App;
