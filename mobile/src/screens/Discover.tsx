import { useEffect, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { api } from "../api";
import { Card, H, Input, P } from "../ui";
import type { Nav } from "../../App";

export function DiscoverScreen({ nav }: { nav: Nav }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    const id = setTimeout(() => api<any[]>(`/public/businesses?q=${encodeURIComponent(q)}`).then(setItems).catch(() => {}), 250);
    return () => clearTimeout(id);
  }, [q]);
  return (
    <FlatList
      contentContainerStyle={{ padding: 16 }}
      ListHeaderComponent={<View><H size={26}>Book an appointment</H><Input label="Search" placeholder="piano, haircut, tutoring…" value={q} onChangeText={setQ} /></View>}
      data={items}
      keyExtractor={(b) => b.slug}
      renderItem={({ item }) => (
        <Pressable onPress={() => nav.go({ name: "business", slug: item.slug })}>
          <Card><H size={17}>{item.name}</H><P muted small>{item.category}</P><P small>{item.description}</P></Card>
        </Pressable>
      )}
    />
  );
}
