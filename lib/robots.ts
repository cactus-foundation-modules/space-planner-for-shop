// Fed into core's /robots.txt through the module router.
//
// The planner itself is an application, not a page: there is nothing for a
// crawler to index at /space-planner and a great deal for it to waste its time
// on. Shared plans are private-by-obscurity documents belonging to a customer,
// and having one turn up in a search result would be a genuine breach of what
// the shopper thought "share this link with my boss" meant.
//
// The indexable surface is whatever landing page the owner builds with the Puck
// teaser block, which is an ordinary page and needs nothing from us.
export async function getPublicRobotsDisallow(): Promise<string[]> {
  return ['/space-planner', '/space-planner/']
}
