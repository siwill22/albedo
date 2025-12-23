
export interface EBMParams {
  S0: number; // Solar constant [W/m2]
  A: number;  // OLR constant [W/m2]
  B: number;  // OLR linear term [W/m2/C]
  D: number;  // Diffusivity [W/m2/C]
  iceAlbedo: number;
  oceanAlbedo: number;
  iceThreshold: number; // Temperature below which ice forms [C]
}

export const DEFAULT_PARAMS: EBMParams = {
  S0: 1360,
  A: 210,
  B: 2.0,
  D: 0.6, // Diffusion coefficient
  iceAlbedo: 0.62,
  oceanAlbedo: 0.3,
  iceThreshold: -10,
};

export class EBM {
  params: EBMParams;
  size: number;
  lat: Float32Array; // Latitude in degrees
  x: Float32Array;   // sin(lat)
  T: Float32Array;   // Temperature [C]

  // Computed diagnostics
  albedo: Float32Array;
  insol: Float32Array;  // Insolation [W/m2]
  ASR: Float32Array;    // Absorbed Solar Radiation
  OLR: Float32Array;    // Outgoing Longwave Radiation
  transport: Float32Array; // Heat transport convergence

  // Internal buffer
  private _fluxBuffer: Float32Array;

  time: number = 0;

  constructor(size: number = 90, params: EBMParams = DEFAULT_PARAMS) {
    this.size = size;
    this.params = { ...params };

    this.lat = new Float32Array(size);
    this.x = new Float32Array(size);
    this.T = new Float32Array(size);

    this.albedo = new Float32Array(size);
    this.insol = new Float32Array(size);
    this.ASR = new Float32Array(size);
    this.OLR = new Float32Array(size);
    this.transport = new Float32Array(size);

    this._fluxBuffer = new Float32Array(size + 1);

    this.initGrid();
    this.initState();
  }

  initGrid() {
    // Generate grid points x = sin(lat) evenly spaced between -1 and 1
    // Actually, simple EBMs often work best with even steps in x (sine latitude)
    // to preserve area weighting naturally.
    for (let i = 0; i < this.size; i++) {
      // Center of the bands
      const frac = (i + 0.5) / this.size;
      const xVal = -1 + 2 * frac;
      this.x[i] = xVal;
      this.lat[i] = Math.asin(xVal) * (180 / Math.PI);
    }
  }

  initState() {
    // Initial guess: warm earth
    // 1 - 0.5 * x^2 shape roughly
    for (let i = 0; i < this.size; i++) {
      this.T[i] = 15 + 20 * (1 - 2 * this.x[i] * this.x[i]);
    }
    this.updateDiagnostics();
  }

  // Legendre polynomial P2(x) = 1/2 * (3x^2 - 1)
  // Annual mean insolation Q(x) ~ S0/4 * (1 + s2 * P2(x))
  // s2 ~ -0.482 for Earth
  computeInsolation() {
    const s2 = -0.482;
    for (let i = 0; i < this.size; i++) {
      const P2 = 0.5 * (3 * this.x[i] * this.x[i] - 1);
      this.insol[i] = (this.params.S0 / 4) * (1 + s2 * P2);
    }
  }

  computeAlbedo() {
    for (let i = 0; i < this.size; i++) {
      // Simple step function
      // Or ramp. Let's use step to get sharp transitions like the text suggests
      this.albedo[i] = this.T[i] < this.params.iceThreshold
        ? this.params.iceAlbedo
        : this.params.oceanAlbedo;
    }
  }

  computeTransport() {
    // Diffusion: D * d/dx ( (1-x^2) dT/dx )
    // Finite difference
    // We need fluxes at interfaces.
    // Grid:
    //  |  0  |  1  | ...
    // i=0   i=1
    // x[0]  x[1]

    const dx = 2 / this.size;
    const D = this.params.D; // This D usually scales with something.
    // D unit check: 
    // Heat balance: C dT/dt = ... + div(F)
    // In 1D x-coords: d/dx ( (1-x^2) D_diff dT/dx )
    // Let's assume params.D includes the scaling factors fitting the unit W/m2/C roughly.

    // Fluxes at boundaries i-1/2.
    // flux[i] is flux between cell i-1 and i.
    // flux[0] is south pole (0), flux[size] is north pole (0).

    // flux[i] is flux between cell i-1 and i.
    // flux[0] is south pole (0), flux[size] is north pole (0).

    const flux = this._fluxBuffer;

    for (let i = 1; i < this.size; i++) {
      const x_interface = -1 + i * dx;
      const cos2_interface = 1 - x_interface * x_interface;
      const dT_dx = (this.T[i] - this.T[i - 1]) / dx;
      flux[i] = -D * cos2_interface * dT_dx;
    }
    flux[0] = 0;
    flux[this.size] = 0;

    for (let i = 0; i < this.size; i++) {
      // Divergence
      this.transport[i] = -(flux[i + 1] - flux[i]) / dx;
    }
  }

  updateDiagnostics() {
    // computeInsolation is expensive and static (unless S0 changes). 
    // It is now called explicitly by external controller when Parameters change.

    this.computeAlbedo();

    for (let i = 0; i < this.size; i++) {
      this.ASR[i] = this.insol[i] * (1 - this.albedo[i]);
      this.OLR[i] = this.params.A + this.params.B * this.T[i];
    }

    this.computeTransport();
  }

  step(dt: number = 0.5) {
    // Stability check for diffusion: dt < dx^2 / (2 * D)
    // dx = 2 / size.
    const dx = 2.0 / this.size;
    // We need to be careful with the (1-x^2) factor in diffusion, but the raw D/dx^2 is the main constraint.
    // Let's use a safety factor.
    const stabilityLimit = (dx * dx) / (2 * this.params.D + 0.001); // Avoid div/0

    // We want to take a total step of 'dt'.
    // We must break it into substeps smaller than stabilityLimit.
    const safeDt = stabilityLimit * 0.8; // 20% safety margin

    let timeRemaining = dt;
    let stepsTaken = 0;

    const heatCapacity = 10.0; // Arbitrary visualization inertia

    while (timeRemaining > 0.000001) {
      const dt_sub = Math.min(timeRemaining, safeDt);

      this.updateDiagnostics();

      // Check for NaN before update
      if (stepsTaken % 100 === 0 && isNaN(this.T[45])) {
        console.error("NaN detected in Physics Engine!", {
          time: this.time,
          T_equator: this.T[45],
          albedo_equator: this.albedo[45],
          ASR: this.ASR[45],
          OLR: this.OLR[45]
        });
        return;
      }

      for (let i = 0; i < this.size; i++) {
        // Simple Euler
        const netFlux = this.ASR[i] - this.OLR[i] + this.transport[i];
        this.T[i] += (netFlux / heatCapacity) * dt_sub;
      }

      timeRemaining -= dt_sub;
      stepsTaken++;

      // Failsafe exit if we spiral
      if (stepsTaken > 10000) {
        console.warn("Physics integration taking too many substeps. Breaking to preserve UI.");
        break;
      }
    }

    this.time += dt;

    // Debug logging sporadically
    if (Math.random() < 0.01) {
      console.log(`[EBM] Time: ${this.time.toFixed(2)}, MeanT: ${this.getGlobalMeanTemp().toFixed(2)}, Substeps: ${stepsTaken}`);
    }
  }

  getGlobalMeanTemp(): number {
    // Area weighted mean
    // Since our grid is even in x=sin(lat), area weighting is uniform 1/N.
    let sum = 0;
    for (let t of this.T) sum += t;
    return sum / this.size;
  }

  getGlobalMeanNetFlux(): number {
    let sum = 0;
    for (let i = 0; i < this.size; i++) {
      sum += (this.ASR[i] - this.OLR[i]);
    }
    return sum / this.size;
  }
}
