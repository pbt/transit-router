import * as PropTypes from 'prop-types';
import * as React from 'react';
import * as _ from 'underscore';
import { Feature } from '.';

import {CenterZoomLevel, LatLng} from '../coordinates';
import * as utils from '../utils';
import {CanvasOverlay, StyledFeatureData} from './canvas-overlay';

const MAP_TYPE_IDS = [google.maps.MapTypeId.ROADMAP, google.maps.MapTypeId.SATELLITE, 'customMap'];
const DEFAULT_DRAGGABLE_CURSOR = 'default';

export interface BoxPlusLevel extends CenterZoomLevel {
  northeast: LatLng;
  southwest: LatLng;
}

export interface MapProps {
  /**
   * Which area should the map display?
   * This sets the initial viewport and changes to it will cause transitions on the map.
   *
   * The map is not a controlled component, so the user can pan and zoom independently of this
   * property. These bounds changes will be passed through the onBoundsChanged handler. Setting
   * this prop to match the value in onBoundsChanged will not cause a redraw.
   */
  view: CenterZoomLevel;

  /** Data and styles to attach to the map. The order of layers is top-to-bottom. */
  data: StyledFeatureData[];

  /** Fired when the Google Map base layer has loaded. */
  onLoad?: () => void;

  /**
   * Any click on the base map.
   *
   * 'feature' is the feature clicked on, if any, and 'layerIndex' is the layer to which
   * it belongs. If the click was on the base map then both will be null.
   */
  onClick?: (
    event: google.maps.Data.MouseEvent,
    layerIndex?: number,
    feature?: Feature,
  ) => void;

  /** If specified, use this as the mouse pointer when hovering over clickable features. Otherwise
   *  use 'default' pointer whether hovering or not.
   */
  onMouseOverPointer?: string;

  /** Fired if any error happens. */
  onError: (error: Error) => void;

  /** Fired when the map bounds changed for any reason. */
  onBoundsChanged?: (bounds: BoxPlusLevel) => void;

  /** The style of the base map. */
  mapStyles?: google.maps.MapTypeStyle[];

  /** The lower and upper bounds on the zoom-level. */
  minZoom?: number;
  maxZoom?: number;

  /** The position and visibility of the controls of the map. */
  controlPosition?: google.maps.ControlPosition;
  hideControls?: boolean;

  style?: React.CSSProperties;
}

export interface MapState {}

export interface MapContext {
  map: google.maps.Map;
}

/**
 * A map component that displays styled GeoJSON data overlaid on Google Maps.
 * This results in a map that is faster to draw (and thus can show more data at once) than one
 * using Google Maps' built-in data layer. But (because we index the data) we still support
 * interacting with the overlaid objects.
 */
export class OverlayMap extends React.Component<MapProps, MapState> {
  /**
   * The Google Maps map instance. Can be accessed via ref.
   *
   * Don't use methods on this which affect the state of the map. It's best used to
   * access data about the map, e.g. its viewport.
   */
  public map: google.maps.Map = null;
  mapOffsetLeft: number = 0;
  mapIsReady: boolean = false;
  private overlay: CanvasOverlay;

  static childContextTypes = {
    map: PropTypes.object,
  };

  getChildContext() {
    return {
      map: this.map,
    };
  }

  constructor(props: MapProps) {
    super(props);

    this.overlay = new CanvasOverlay(error => this.props.onError(error));
  }

  render() {
    return (
      <div>
        <div ref="map" className="map" style={this.props.style} />
        {this.props.children}
      </div>
    );
  }

  componentDidMount() {
    const position = this.props.controlPosition || google.maps.ControlPosition.TOP_RIGHT;
    const mapEl = this.refs['map'] as HTMLElement;

    const {hideControls, mapStyles, maxZoom, minZoom, onMouseOverPointer, view} = this.props;

    this.map = new google.maps.Map(mapEl, {
      mapTypeControl: !hideControls,
      mapTypeControlOptions: {
        mapTypeIds: MAP_TYPE_IDS,
        position,
      },
      streetViewControl: false,
      zoomControl: !hideControls,
      zoomControlOptions: {
        position,
      },
      center: view.center,
      zoom: view.zoomLevel,
      maxZoom,
      minZoom,
      fullscreenControl: false,
    });
    this.map.setOptions({draggableCursor: DEFAULT_DRAGGABLE_CURSOR});

    this.mapOffsetLeft = mapEl.offsetLeft;

    if (mapStyles) {
      const customMap = new google.maps.StyledMapType(mapStyles, {name: 'Simple'});
      this.map.mapTypes.set('customMap', customMap);
      this.map.setMapTypeId('customMap');
    }

    google.maps.event.addListenerOnce(this.map, 'idle', () => {
      this.mapIsReady = true;
      if (this.props.onLoad) {
        this.props.onLoad();
      }
    });

    this.map.addListener('click', event => {
      if (this.props.onClick) {
        const layerFeature = this.overlay.hitTest(event.latLng);
        this.props.onClick(event as any, layerFeature && layerFeature[0], layerFeature && layerFeature[1]);
      }
    });

    if (onMouseOverPointer) {
      // Change the pointer when mousing over any feature.
      this.map.addListener(
        'mousemove',
        _.throttle((event: any) => {
          const draggableCursor = this.overlay.hitTest(event.latLng)
            ? onMouseOverPointer
            : DEFAULT_DRAGGABLE_CURSOR;
          this.map.setOptions({draggableCursor});
        }, 100),
      );
    }

    this.map.addListener('bounds_changed', () => {
      this.overlay.draw();

      const bounds = this.map.getBounds();
      const northeast = bounds.getNorthEast();
      const southwest = bounds.getSouthWest();
      const center = this.map.getCenter();

      const box = {
        northeast: new LatLng(northeast.lat(), northeast.lng()),
        southwest: new LatLng(southwest.lat(), southwest.lng()),
        center: new LatLng(center.lat(), center.lng()),
        zoomLevel: this.map.getZoom(),
      } as BoxPlusLevel;

      if (this.props.onBoundsChanged) {
        this.props.onBoundsChanged(box);
      }
    });

    this.overlay.setMap(this.map);

    // Update map if map data is passed into props at initialization.
    if (this.props.data) {
      this.overlay.updateData(this.props.data);
    }

    this.setState({}); // force updates on child nodes.
  }

  // Check for changes to the data. The comparison here is just shallow enough.
  private didDataChange(prevData: StyledFeatureData[], data: StyledFeatureData[]): boolean {
    if (prevData.length !== data.length) return true;
    for (const [oldEl, newEl] of utils.zip(prevData, data)) {
      if (!utils.shallowEqual(oldEl, newEl)) return true;
    }
    return false;
  }

  componentDidUpdate(prevProps: MapProps, prevState: MapState) {
    if (this.didDataChange(this.props.data, prevProps.data)) {
      this.overlay.updateData(this.props.data);
    }

    // Check for changes to the viewport.
    if (!_.isEqual(this.props.view, prevProps.view)) {
      const {center, zoomLevel} = this.props.view;
      this.map.setCenter(center);
      this.map.setZoom(zoomLevel);
    }

    // Check for changes in control settings.
    if (
      this.props.controlPosition !== prevProps.controlPosition ||
      this.props.hideControls !== prevProps.hideControls
    ) {
      const position = this.props.controlPosition || google.maps.ControlPosition.TOP_RIGHT;
      this.map.setOptions({
        mapTypeControl: !this.props.hideControls,
        mapTypeControlOptions: {
          mapTypeIds: MAP_TYPE_IDS,
          position,
        },
        zoomControl: !this.props.hideControls,
        zoomControlOptions: {
          position,
        },
      });
    }
  }

  shouldComponentUpdate(nextProps: MapProps, nextState: MapState): boolean {
    // If nothing in props or state changes, then there's no need to re-render.
    // This might cause unnecessary re-renders, but it won't miss any necessary ones.
    return !(
      utils.shallowEqual(nextProps, this.props) && utils.shallowEqual(nextState, this.state)
    );
  }
}
