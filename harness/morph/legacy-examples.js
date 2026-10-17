// Historical prototype regression inputs; none of these presets ship in @comice/morph.
import { examples as demos } from '/demo/morph/examples.js'
const classic = { liquid: 1, stagger: 0, cursorFollow: true }
const layouts = { circles:'circles',symbols:'symbols',arches:'arches',fan:'fan',deck:'deck',petals:'petals' }
export const examples = demos.map(demo => {
  let options
  if (layouts[demo.id]) options = {...classic,operation:'recompose',layout:layouts[demo.id],direction:'reverse'}
  else if (demo.id === 'apple') options = {...classic,operation:'mask',maskStyle:'contour',direction:'reverse',liquidSheen:.22,maskSize:.84,maskDistance:.1725,maskRasterization:{resolution:[1024,1024],maxDistance:192,fill:.78,alphaThreshold:127}}
  else if (demo.id === 'wordmark') options = {...classic,operation:'recompose',layout:'waveTiles',recomposeTarget:'mask',recomposeStart:.68,recomposeEnd:.98,maskDistance:.17,maskRasterization:{resolution:[1024,576],maxDistance:96}}
  else if (demo.square) options = {operation:'mask',maskStyle:'liquid',liquid:1,maskDistance:.22,maskRasterization:{resolution:[1024,1024],maxDistance:192,fill:.82}}
  else options = {...classic,operation:'recompose',layout:demo.id === 'photo-breakout'?'fan':'shelf',...(demo.id.endsWith('breakout')?{direction:'reverse'}:{})}
  // The demo's relative asset paths, as absolute URLs from this page.
  // The comparison renders the footage each demo was tuned on (the page now alternates
  // the two clips down the list): the tailor for masks and Hero Merge, the hand for the rest.
  const src = demo.square || demo.id === 'hero-merge' ? '/demo/assets/video/b.mp4' : '/demo/assets/video/a.mp4'
  return {...demo,src,...(demo.mask && { mask: new URL(demo.mask, location.origin + '/demo/morph/').pathname }),options}
})
