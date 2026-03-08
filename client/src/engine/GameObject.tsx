import { Switch, Match, type JSX } from "solid-js";
import type {
  GameObject as GameObjectType,
  GameObjectEntry,
} from "../generated";
import RoadNode from "./objects/RoadNode";
import BuildingObject from "./objects/BuildingObject";
import CarObject from "./objects/CarObject";

export type KindEntry<K extends GameObjectType["kind"]> = GameObjectEntry & {
  object: Extract<GameObjectType, { kind: K }>;
};

function MatchKind<K extends GameObjectType["kind"]>(props: {
  entry: GameObjectEntry;
  kind: K;
  children: (entry: () => KindEntry<K>) => JSX.Element;
}) {
  return (
    <Match when={props.entry.object.kind === props.kind && (props.entry as KindEntry<K>)}>
      {props.children}
    </Match>
  );
}

export default function GameObject(props: { entry: GameObjectEntry }) {
  return (
    <Switch>
      <MatchKind entry={props.entry} kind="RoadNode">
        {(entry) => <RoadNode entry={entry()} />}
      </MatchKind>
      <MatchKind entry={props.entry} kind="Building">
        {(entry) => <BuildingObject entry={entry()} />}
      </MatchKind>
      <MatchKind entry={props.entry} kind="Car">
        {(entry) => <CarObject entry={entry()} />}
      </MatchKind>
    </Switch>
  );
}
