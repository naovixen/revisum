// A list holding at least one item.
export type NonEmptyList<Item> = readonly [Item, ...Item[]];

// Each item of a list holding at least one, read in order, into a list that holds at least one too.
export const mapNonEmpty = <Item, Read>(
    list: NonEmptyList<Item>,
    read: (item: Item, index: number) => Read,
): [Read, ...Read[]] => {
    const [first, ...rest] = list;
    return [read(first, 0), ...rest.map((item, index) => read(item, index + 1))];
};
