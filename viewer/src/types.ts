// Mirror of the producer-side viewer types (src/shared/types.ts).

export interface Device {
  name: string;
  width: number;
  height: number;
  dpr: number;
  mobile?: boolean;
}

export interface ViewerTile {
  id: string;
  routeId: string;
  routeUrl: string;
  routePath: string;
  stateId: string;
  stateLabel: string;
  stateKind: string;
  device: string;
  full: string;
  thumb?: string;
  width?: number;
  height?: number;
}

export interface ViewerData {
  site: { baseUrl: string; origin: string; title?: string; runId: string; generatedAt: string };
  devices: Device[];
  tiles: ViewerTile[];
  groups: { path: string; routeId: string; title?: string }[];
}
