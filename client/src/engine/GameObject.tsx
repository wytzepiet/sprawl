import { Switch, Match } from "solid-js";
import type {
  GameObject as GameObjectType,
  GameObjectEntry,
} from "../generated";
import RoadNode from "./objects/RoadNode";
import BuildingObject from "./objects/BuildingObject";
import CarObject from "./objects/CarObject";
import TerrainTile from "./objects/TerrainTile";
import TerrainBorder from "./objects/TerrainBorder";

export type KindEntry<K extends GameObjectType["kind"]> = GameObjectEntry & {
  object: Extract<GameObjectType, { kind: K }>;
};

function MatchKind<K extends GameObjectType["kind"]>(props: {
  kind: K;
  entry: () => GameObjectEntry;
  component: (props: { entry: KindEntry<K> }) => any;
}) {
  return (
    <Match when={props.entry().object.kind === props.kind}>
      {(() => {
        const C = props.component;
        return <C entry={props.entry() as KindEntry<K>} />;
      })()}
    </Match>
  );
}

export default function GameObject(props: { entry: GameObjectEntry }) {
  const e = () => props.entry;

  return (
    <Switch>
      <MatchKind kind="RoadNode" entry={e} component={RoadNode} />
      <MatchKind kind="Building" entry={e} component={BuildingObject} />
      <MatchKind kind="Car" entry={e} component={CarObject} />
      <MatchKind kind="Terrain" entry={e} component={TerrainTile} />
      <MatchKind kind="TerrainBorder" entry={e} component={TerrainBorder} />
    </Switch>
  );
}
