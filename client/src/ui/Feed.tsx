/** @jsxImportSource ~ui */
import { news, type News } from "../state/town";
import { setFollowing } from "../state/selection";
import { view, wide } from "./kit";
import { Stack } from "./stack";
import type { JSX } from "~ui/jsx-runtime";

/** Where the feed starts, and the room it leaves below it: on a wide
 *  screen the dock; on a phone the dial's row over it, and the dock and
 *  the sheet's head under it. */
const TOP = () => (wide() ? 24 : 76);
const BELOW = () => (wide() ? 112 : 180);

/** A family's house, for the news of them. */
const HOME = "M12 3l9 8h-2.5v9h-5v-6h-3v6h-5v-9H3z";

/**
 * The feed: what happens to the town as a phone's notifications, top
 * right, or across the top of a phone. News drops in on top and goes by
 * itself.
 */
export default function Feed() {
  const room = () => view().h - TOP() - BELOW();
  return (
    <box at={wide() ? { right: 24, top: TOP() } : { left: 12, right: 12, top: TOP() }} w={wide() ? 340 : undefined} gap={8}>
      <Stack each={[...news()].reverse()} key={(n) => `news:${n.key}`} open={false} room={room()} keep={null} glass="note" round={20}>
        {(n) => <NewsCard news={n()} />}
      </Stack>
    </box>
  );
}

/** A square of colour with a glyph on it: what a card is about. */
const Tile = (props: { color: string; d: string; children?: JSX.Element }) => (
  <box w={36} h={36} round={11} fill={props.color} align="center" justify="center">
    <icon d={props.d} size={20} ink="white" />
    {props.children}
  </box>
);

/** A line of news: the ferry in, the ferry gone, coins spent; a tap goes there. */
function NewsCard(props: { news: News }) {
  return (
    <box dir="row" align="center" gap={10} pad={{ y: 10, x: 12 }} onTap={() => setFollowing(props.news.at)}>
      <Tile color="#C2603A" d={HOME} />
      <box grow={1} gap={2}>
        <text size={14.5} weight={600} lines={1}>{props.news.text}</text>
        <text size={12.5} soft lines={1}>{props.news.sub}</text>
      </box>
    </box>
  );
}

