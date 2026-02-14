const path = require('node:path');
const geolib= require('geolib');
const _ = require('lodash')

// The course change path sends these PGNs at most this often, whatever
// produces the changes; the timer sends a value held back by it.
const raymarineOnChangeMinInterval = 1000

// An incrementing SID so that a receiver can tell one 130848 from the next.
let sid130848 = 0

function toRadians(value) {
  return (value * Math.PI) / 180;
}

// Raymarine waypoint information (130848), or null without a destination. The
// calculated values are read from the Signal K tree and the destination from
// the Course API, so the same data can be sent by the timer and by a course
// change.
async function raymarineRouteWP(app) {
  const course = await app.courseApi.getCourse()
  if (!course?.nextPoint)
    return null

  const calcValues = app.getSelfPath('navigation.course.calcValues') || {}

  let waypointId = 1
  let waypointName = "Destination"
  if (course.activeRoute && typeof course.activeRoute.pointIndex === 'number') {
    waypointId = course.activeRoute.pointIndex + 1
    waypointName = "Waypoint " + waypointId.toString()
  }

  sid130848 = sid130848 == 252 ? 0 : sid130848 + 1

  return [{
    pgn: 130848,
    "dst": 255,
    "Manufacturer Code": "Raymarine",
    "Industry Code": "Marine Industry",
    "SID": sid130848,
    "Waypoint Name": waypointName,
    "Waypoint Sequence": waypointId.toString().padStart(4, '0'),
    "Bearing to Waypoint, True": calcValues.bearingTrue?.value,
    "Bearing to Waypoint, Magnetic": calcValues.bearingMagnetic?.value,
    "Distance to Waypoint": calcValues.distance?.value
  }]
}

// Raymarine current and next waypoint information (130918), or null without a
// destination. Like 130848, the calculated values and vessel position are read
// from the tree, so the timer and a course change share the same worker.
async function raymarineRouteInfo(app) {
  const course = await app.courseApi.getCourse()
  if (!course?.nextPoint)
    return null

  const calcValues = app.getSelfPath('navigation.course.calcValues') || {}
  const distance = calcValues.distance?.value
  const bearingTrue = calcValues.bearingTrue?.value
  const position = app.getSelfPath('navigation.position')?.value

  let currentWaypointId = 1
  let currentWaypointName = "Destination"
  let nextWaypointId = 255
  let nextWaypointName = undefined
  let unknownFlags = 0
  let bearingCurrentToNext = undefined
  let bearingPositionToNext = undefined
  let distancePositionToNext = undefined

  if (course.activeRoute != null) {
    currentWaypointId = course.activeRoute.pointIndex + 1
    currentWaypointName = "Waypoint " + currentWaypointId.toString()
  }

  if (course.activeRoute == null || course.activeRoute.pointIndex + 1 == course.activeRoute.pointTotal) {
    unknownFlags = 13
    distancePositionToNext = distance
    bearingPositionToNext = bearingTrue
  } else {
    const route = await app.resourcesApi.getResource('routes', path.basename(course.activeRoute.href))
    if (course.activeRoute.pointIndex + 2 == course.activeRoute.pointTotal)
      unknownFlags = 4

    nextWaypointId = currentWaypointId + 1
    nextWaypointName = "Waypoint " + nextWaypointId.toString()
    const nextWaypointLatLng = route.feature.geometry.coordinates[course.activeRoute.pointIndex + 1]

    bearingPositionToNext = toRadians(
      geolib.getGreatCircleBearing(position, nextWaypointLatLng)
    )
    distancePositionToNext = geolib.getPreciseDistance(position, nextWaypointLatLng)

    const currentWaypointLatLng = route.feature.geometry.coordinates[course.activeRoute.pointIndex]
    bearingCurrentToNext = toRadians(
      geolib.getGreatCircleBearing(currentWaypointLatLng, nextWaypointLatLng)
    )
  }

  return [{
    pgn: 130918,
    "dst": 255,
    "Manufacturer Code": "Raymarine",
    "Industry Code": "Marine Industry",
    "Current Waypoint Name": currentWaypointName,
    "Current Waypoint Sequence": currentWaypointId,
    "Next Waypoint Sequence": nextWaypointId,
    "Next Waypoint Name": nextWaypointName,
    "Unknown": unknownFlags,
    'Bearing, Current Waypoint to Next Waypoint, True': bearingCurrentToNext,
    'Bearing, Position to Next Waypoint, True': bearingPositionToNext,
    'Distance, Position to Next Waypoint': distancePositionToNext,
  }]
}

module.exports = (app, plugin) => {
  return [{
    title: 'Raymarine Route and Waypoint Information (130848, 130918)',
    optionKey: 'RAYMARINENAV',
    conversions: (options) => {
      // A timer and a course change both send through a rate-limited sender,
      // so a change just before a timer tick cannot put two of the same PGN on
      // the bus in the same second. A send that produces nothing does not
      // count.
      function rateLimited(worker) {
        let lastSentAt = 0
        let lastChangeSentAt = 0
        return async (app, onCourseChange) => {
          const now = Date.now()
          const since = onCourseChange ? lastSentAt : lastChangeSentAt
          if (now - since < raymarineOnChangeMinInterval)
            return null
          const pgns = await worker(app)
          if (pgns != null) {
            lastSentAt = now
            if (onCourseChange)
              lastChangeSentAt = now
          }
          return pgns
        }
      }

      // A course change sends at once, but only when the course itself changed
      // and there is a destination; the sender applies the shared rate limit.
      function onCourseChange(sender) {
        let lastCourse
        return (activeRoute, nextPoint, previousPoint) => {
          const course = [activeRoute, nextPoint, previousPoint]
          if (_.isEqual(course, lastCourse))
            return null
          lastCourse = course
          if (!nextPoint)
            return null
          return sender(app, true)
        }
      }

      const courseKeys = [
        'navigation.course.activeRoute',
        'navigation.course.nextPoint',
        'navigation.course.previousPoint'
      ]
      const sendRouteWP = rateLimited(raymarineRouteWP)
      const sendRouteInfo = rateLimited(raymarineRouteInfo)

      return [{
        // The values are read from the tree per tick, so that a value the
        // server has nulled as stale is not sent forever.
        interval: 1000,
        sourceType: 'timer',
        callback: (app) => sendRouteWP(app, false),
        tests: [{
          input: [ mockApp ],
          expected: [{
            "__preprocess__": (testResult) => {
              // the SID increments on every message
              delete testResult.fields.SID
            },
            "prio": 2,
            "pgn": 130848,
            "dst": 255,
            "fields": {
              "Industry Code": "Marine Industry",
              "Manufacturer Code": "Raymarine",
              "Waypoint Name": "Waypoint 1",
              "Waypoint Sequence": "0001",
              "Bearing to Waypoint, True": 0.1885,
              "Bearing to Waypoint, Magnetic": 0.3392,
              "Distance to Waypoint": 1915751
            }
          }]
        }]
      }, {
        keys: courseKeys,
        callback: onCourseChange(sendRouteWP),
        tests: [{
          // no course
          input: [null, null, null],
          expected: []
        }]
      }, {
        interval: 1000,
        sourceType: 'timer',
        callback: (app) => sendRouteInfo(app, false),
        tests: [{
          input: [ mockApp ],
          expected: [{
            "prio": 2,
            "pgn": 130918,
            "dst": 255,
            "fields": {
              "Industry Code": "Marine Industry",
              "Manufacturer Code": "Raymarine",
              "Current Waypoint Name": "Waypoint 1",
              "Current Waypoint Sequence": 1,
              "Next Waypoint Name":"Waypoint 2",
              "Next Waypoint Sequence": 2,
              "Unknown": 0,
              "Bearing, Current Waypoint to Next Waypoint, True": 4.225,
              "Bearing, Position to Next Waypoint, True": 4.0099,
              "Distance, Position to Next Waypoint": 374,
            }
          }]
        }]
      }, {
        keys: courseKeys,
        callback: onCourseChange(sendRouteInfo),
        tests: [{
          // no course
          input: [null, null, null],
          expected: []
        }]
      }]
    }
  }]
}

// The course values and vessel position as the workers read them: nested so
// that a subtree can be read in one getSelfPath call.
function mockSelf(values) {
  const tree = {}
  Object.entries(values).forEach(([key, value]) => {
    _.set(tree, key, { value })
  })
  return (key) => _.get(tree, key)
}

var mockApp = {
  courseApi: {
    getCourse: () => {
      return {
        nextPoint: {
          position: {
            longitude: -78.635903,
            latitude: 26.517348
          },
          type: "Location"
        },
        activeRoute: {
          href: 'mock',
          pointIndex: 0,
          pointTotal: 12
        }
      }
    }
  },
  resourcesApi: {
    getResource: () => {
      return {
        name: 'Lucaya To West Palm Beach',
        description: 'Your route',
        feature: {
          type: 'Feature',
          properties: {
            _gpxType: 'rte',
            name: 'Lucaya To West Palm Beach',
            cmt: 'redID',
            desc: 'Your route'
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [ -78.635903, 26.517348 ],
              [ -78.637866, 26.516417 ],
              [ -78.637737, 26.515296 ],
              [ -78.636158, 26.514194 ],
              [ -78.634808, 26.511982 ],
              [ -78.62966, 26.49787 ],
              [ -78.62181, 26.486673 ],
              [ -78.7087, 26.476476 ],
              [ -80.023545, 26.771407 ],
              [ -80.037314, 26.772696 ],
              [ -80.049322, 26.768562 ],
              [ -80.047748, 26.747961 ],
            ]
          }
        }
      }
    }
  },
  getSelfPath: mockSelf({
    'navigation.course.calcValues.distance': 1915751,
    'navigation.course.calcValues.bearingTrue': 0.1885,
    'navigation.course.calcValues.bearingMagnetic': 0.3392,
    'navigation.position': { longitude: -78.6349923366475, latitude: 26.51859369671446 }
  })
}
