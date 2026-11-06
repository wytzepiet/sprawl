import { Box, Icon, Text } from "~ui";
import { news, type News } from "../state/town";
import { setFollowing } from "../state/selection";
import { bezel, CORNER, view, wide, ROUND } from "./kit";
import { Stack } from "./stack";

/** Where the feed starts, and the room it leaves below it. */
const TOP = () => bezel() + CORNER + (wide() ? 14 : 12);
const BELOW = () => (wide() ? 112 : 180);
/** A sun over the horizon: the day's news. */
const SUN = "M12 7a5 5 0 0 1 5 5H7a5 5 0 0 1 5-5zM2 14h20v2H2zM11 2h2v3h-2zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z";

/**
 * The feed: what happens to the town as a phone's notifications, top
 * right, or across the top of a phone: who moved in, who left, the dawn.
 * The newest in front, two more peeking under it; each goes by itself.
 */
export default function Feed() {
  const room = () => view().h - TOP() - BELOW();
  return (
    <Box at={wide() ? { right: bezel() + 14, top: TOP() } : { left: bezel() + 10, right: bezel() + 10, top: TOP() }} w={wide() ? 340 : undefined}>
      <Stack each={[...news()].reverse()} key={(n) => `news:${n.key}`} open={false} room={room()} glass="note" round={ROUND}>
        {(n) => <NewsCard news={n()} />}
      </Stack>
    </Box>
  );
}

function NewsCard(props: { news: News }) {
  return (
    <Box dir="row" align="center" gap={10} pad={{ y: 10, x: 12 }} onTap={() => props.news.at && setFollowing(props.news.at)}>
      <Box w={34} h={34} round={17} fill="#FF9F0A" align="center" justify="center">
        <Icon d={SUN} size={20} ink="white" />
      </Box>
      <Box grow={1} gap={2}>
        <Text size={14.5} weight={600} lines={1}>{props.news.text}</Text>
        <Text size={12.5} soft lines={1}>{props.news.sub}</Text>
      </Box>
    </Box>
  );
}
