// Expected selectors/data belong only to acceptance, never the downloader.
export function ownedChecks() {
  const all=['owned-001','owned-002','owned-003','owned-004'];
  const states={all,home:['owned-001','owned-004'],stationery:['owned-002'],bags:['owned-003'],missing:[],clear:all};
  const checks=[];
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    checks.push({id:`grid-navigation-${viewport.width}`,path:'/grid.html',viewport,steps:[
      {type:'assert',selector:'#product-grid .product-card',count:4,ids:all,columns:viewport.width>700?4:2},
      {type:'assert',selector:'h1',fontLoaded:true},
      {type:'assert',selector:'#site-menu',visible:false},
      {type:'click',selector:'.menu-toggle'},
      {type:'assert',selector:'#site-menu',visible:true},
      {type:'click',selector:'#site-menu a[href="/lazy.html"]'},
      {type:'assert',selector:'h1',text:'Scroll to reveal'},
    ]});
    checks.push({id:`menu-filters-${viewport.width}`,path:'/filters.html',viewport,steps:[
      {type:'assert',selector:'#site-menu',visible:false},
      {type:'click',selector:'.menu-toggle'},
      {type:'assert',selector:'#site-menu',visible:true},
      {type:'click',selector:'.menu-toggle'},
      {type:'assert',selector:'#site-menu',visible:false},
      ...Object.entries(states).flatMap(([name,ids])=>[
        {type:'click',selector:`[data-filter=${name}]`},
        {type:'assert',selector:'#filter-grid .product-card',count:ids.length,ids},
        {type:'assert',selector:`[data-filter=${name}]`,attribute:'class',value:'filter is-selected'},
      ]),
    ]});
    checks.push({id:`lazy-${viewport.width}`,path:'/lazy.html',viewport,steps:[
      {type:'assert',selector:'#lazy-panel',attribute:'data-loaded',value:'false',backgroundLoaded:false},
      {type:'scroll',selector:'#lazy-panel'},
      {type:'assert',selector:'#lazy-panel',attribute:'data-loaded',value:'true',backgroundLoaded:true},
      {type:'assert',selector:'#lazy-status',text:'Background and SVG loaded'},
    ]});
  }
  return checks;
}
